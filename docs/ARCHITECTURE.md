# MergeSutra — Architecture

Status: Stages 0-6 implement the components marked **[IMPLEMENTED]**; the rest
are **[DESIGNED]** / **[PLANNED]**. This document describes the whole intended
architecture so the built pieces fit it.

## 1. Trust model in one breath

> BharatCode decides and proposes.
> MergeSutra constrains and orchestrates.
> Repository tools execute.
> Deterministic gates verify.
> Evidence records what actually happened.
> Human decides whether to publish.

## 2. Component diagram

```mermaid
flowchart TD
    subgraph Input
        URL[GitHub Issue URL]
        LOCAL[Local repository]
    end

    URL --> INTAKE[Intake / URL parser]
    LOCAL --> INTAKE
    INTAKE --> DISC[Repository + Policy Compiler]

    DISC --> CONTRACT[(Acceptance Contract)]
    CONTRACT --> PLAN[BharatCode Planner]
    PLAN --> APPROVE{Policy / Approval gate}
    APPROVE -->|read-only ok| IMPL[Safe Worktree + Tool Controller]
    APPROVE -->|remote mutation| HUMAN[Human approval]

    IMPL --> BH[BharatCode Implementer]
    BH --> VERIFY[Deterministic Verification Engine]
    VERIFY --> REVIEW[BharatCode Diff Reviewer - critique only]
    REVIEW -->|justified problem| REPAIR[Bounded Repair] --> IMPL
    REVIEW --> MAP[Evidence Mapper]
    VERIFY --> MAP
    CONTRACT --> MAP
    MAP --> PACK[(Evidence Pack)]
    MAP --> HUMAN
    HUMAN --> PR[PR Draft]

    classDef ai fill:#e6f0ff,stroke:#3b82f6,color:#111;
    classDef det fill:#e8f7ee,stroke:#22c55e,color:#111;
    classDef human fill:#fff4e0,stroke:#f59e0b,color:#111;
    class BH,PLAN,REVIEW,BH ai;
    class DISC,IMPL,VERIFY,MAP,REPAIR,INTAKE det;
    class HUMAN,APPROVE human;
```

Blue = AI-powered (BharatCode). Green = deterministic. Orange = human.

## 3. AI / deterministic boundary

The model is used only where judgment genuinely helps (issue understanding,
planning, code generation, diff critique). Everything that can be decided
deterministically is **not** delegated to the model:

- **AI:** implementation plan; the choice of which of eight operations to ask for
  next, and the content of a proposed file; independent diff review. Each
  proposal is constrained by a schema and by a closed list of ids the contract
  already issued — including the criteria a model *suggests*, which stay
  labelled `MODEL CLAIM` inside the plan until a human states them.
- **Deterministic:** URL/repo parsing; policy compilation; criteria derivation;
  plan validation and provenance; worktree creation; **whether a proposed action
  runs at all** — path confinement, risk classification, budget accounting,
  no-progress detection; command execution and exit-code capture; verification
  gates; diff scope analysis; secret scanning; evidence mapping; final status
  computation.

Model output crosses the boundary only through Zod-validated schemas, and only
gets as much authority as the schema has a field for — which is why the plan
schema has no status, evidence or confidence field to fill in, and why the
implementation protocol has no field where a model could declare its own risk
class. The loop's shape is the clearest statement of the rule: BharatCode
proposes an action, deterministic code validates and authorises it, executes it
through the Stage 5 boundaries, and records what actually happened. A `FINISH`
answer is stored as `finishClaim`, because the model is the author of that
sentence and not the judge of it. The reviewer may critique but is never allowed
to silently edit code.

## 4. Trust boundaries

| Boundary      | Untrusted side                              | Enforced by                                        |
| ------------- | ------------------------------------------- | -------------------------------------------------- |
| Model output  | BharatCode text/JSON                        | A closed eight-action discriminated union with `.strict()` variants; Zod schemas; closed criterion-id list; argv-only commands; one bounded repair round; fail-safe |
| Repository    | File contents, CI/lint/test config, docs    | Policy compiler treats text as data, not authority; every sent file labelled untrusted in the prompt |
| Issue/comments| Body text, filenames, comments              | Authority hierarchy; prompt-injection defence      |
| Filesystem (write) | Any write target                       | `security/writer.ts`: relative paths only, every existing ancestor realpath'd and proved inside the workspace, no `.git` segment, no write through a link, byte cap, atomic |
| Filesystem (read)  | Any file a model names                 | `security/reader.ts`: same confinement, plus credential and binary rejection, per-file truncation, and a context budget that can run out |
| Process       | Commands to run                             | argv arrays, no `shell:true`, timeout, bounded output; `process/tool-policy.ts` derives the risk from the argv and refuses an interpreter handed a string; a program token with a space in it is refused before spawn |
| GitHub        | Any remote mutation                         | `tool-policy` approval gate: a remote action needs a human yes for that exact summary, and a destructive one has no yes that enables it. Stage 6 does not offer one: asking to push is a refusal, not a prompt |
| BharatCode    | Endpoint/credentials                        | Env-only config; central redaction; the key is required before a workspace is created |

## 5. Workflow state machine

```mermaid
stateDiagram-v2
    [*] --> INTAKE
    INTAKE --> DISCOVERY
    DISCOVERY --> CONTRACT
    CONTRACT --> PLAN
    PLAN --> APPROVAL
    APPROVAL --> IMPLEMENT
    IMPLEMENT --> VERIFY
    VERIFY --> REVIEW
    REVIEW --> REPAIR: justified problem (bounded)
    REPAIR --> IMPLEMENT
    REVIEW --> EVIDENCE
    VERIFY --> EVIDENCE
    EVIDENCE --> HUMAN_APPROVAL
    HUMAN_APPROVAL --> PR_DRAFT
    PR_DRAFT --> [*]
    HUMAN_APPROVAL --> BLOCKED
    VERIFY --> BLOCKED
```

Built today: `INTAKE → DISCOVERY → CONTRACT → PLAN → IMPLEMENT`, one command each
(`issue`, `inspect`, `contract`, `plan`, `implement`), each writing a run record
that the next one reads. `VERIFY` onward is **[DESIGNED]** — which is why an
`IMPLEMENT`-stage record stops with `nextStage` naming the verification command
that does not exist yet, and why `mergesutra run`, `verify` and `pr` still exit
`2` as planned.

Stage 5 built the two boxes the arrow to the left of `IMPL` depends on — the
worktree and the tool controller — as modules a stage calls, not as a command a
human runs. Stage 6 is the loop that calls them, and it changed the shape of
`IMPLEMENT` in one specific way: the box is entered through a closed list of
eight actions, so the arrow from `BH` back into `IMPL` in the diagram above is
not a model choosing a tool but a deterministic executor deciding whether the
action it was given may run at all.

An implementation run never reaches `EVIDENCE` on its own. It ends at a
workspace full of uncommitted files, an action log, and criteria that are all
still `PENDING`.

Explicit bounded limits: agent steps, tool calls, repair attempts, repeated
identical failures, request/token budget, per-command runtime, and output size.
If progress stalls, the run **stops with evidence** rather than burning requests.

## 6. Layered modules

```
src/
  core/        AppError hierarchy, status enums,         [IMPLEMENTED]
               bounded argv-only process runner
  security/    central secret redaction, path             [IMPLEMENTED]
               confinement, injection signalling, shared
               command-shape rules, confined writer and
               confined reader (one root each)
  config/      env-only configuration loading            [IMPLEMENTED]
  bharatcode/  BharatCodeClient + HTTP adapter, schemas, [IMPLEMENTED]
               retry, timeouts, cancellation
  cli/         command surface, rendering, doctor,        [IMPLEMENTED]
               issue (intake only), inspect, contract,
               plan, implement, exit codes
  intake/      issue URL parsing, local-repo reading,     [IMPLEMENTED]
               intake orchestrator
  github/      gh-CLI source + Zod-validated payloads     [IMPLEMENTED]
  state/       versioned run record + atomic file store   [IMPLEMENTED]
  discovery/   confined repo reader, manifest/CI          [IMPLEMENTED]
               discovery, repository contract
  contract/    Acceptance Contract schema + criteria      [IMPLEMENTED]
               derivation, revision-with-reason
  plan/        plan schema (no status field), prompt      [IMPLEMENTED]
               shaping, coverage checks, planner against
               BharatCodeClient — holds no process runner
  implement/   the bounded loop: closed action protocol,  [IMPLEMENTED]
               context assembler, prompt shaping, twelve
               enforced limits, no-progress identity,
               implementation record (no status field a
               criterion could be marked PASS in)
  git/         worktree at the pinned base SHA,           [IMPLEMENTED]
               ignore pre-flight, dirty-state report,
               idempotent reuse, never a cleanup
  process/     risk-classified tool controller — the       [IMPLEMENTED]
               class comes from the argv, not the caller;
               approval gate, destructive refusal
  verification/deterministic verification engine         [PLANNED]
  review/      independent diff reviewer wiring          [PLANNED]
  evidence/    evidence pack + report renderer           [PLANNED]
```

The loop's dependencies are the whole point of that layout: `implement/` is the
only module that both holds a `BharatCodeClient` and reaches the filesystem, and
it reaches nothing directly. It imports the Stage 5 writer, the Stage 5 reader,
the Stage 5 tool policy, the bounded runner and `git/workspace.ts` — so the
answer to "could a stage after this one bypass the boundaries?" is that there is
no bypass to take, only the same five modules.

## 7. Adapter rule (already implemented)

The rest of the application depends only on the `BharatCodeClient` interface —
`listModels`, `complete`, `completeStructured`, `healthCheck` — never on HTTP
details. `fetch`, the sleeper, and the randomness source are injected so the
entire adapter is offline-testable. This keeps MergeSutra free of any hardcoded
provider assumption while still defaulting to BharatCode's documented
OpenAI-compatible API at `https://bharatcode.ai/api/model/v1`.

`mergesutra plan` is the first consumer, and it uses `complete` only: one
unstructured request whose answer must parse and validate, because
`completeStructured` would let the adapter's own JSON instruction shape the
prompt the planner is trying to control. The planner receives a
`BharatCodeClient`, not a fetch, a key, or a URL — so a test can hand it an
answer and assert what the stage did with it, and the stage cannot reach the
network except through the adapter.

## 8. Evidence pack layout **[DESIGNED]**

```
.mergesutra/runs/<run-id>/
  manifest.json       run identity: repo, branch, base SHA, model, timing
  contract.json       versioned Acceptance Contract with revisions
  plan.json           implementation plan
  commands.jsonl      bounded, redacted command receipts (argv, cwd, exit, time)
  verification.json   gate results with sources
  review.json         reviewer findings
  report.md           human-readable report
  report.json         machine-readable report
```

Never committed automatically; never contains secrets. Until this bundle exists,
each stage writes one JSON run record holding what it established — including
the plan, which lives at `record.plan` rather than in its own file.
