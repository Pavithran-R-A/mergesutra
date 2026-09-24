# MergeSutra — Architecture

Status: Stages 0-4 implement the components marked **[IMPLEMENTED]**; the rest
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

- **AI:** implementation plan; code generation; independent diff review. Each
  proposal is constrained by a schema and by a closed list of ids the contract
  already issued — including the criteria a model *suggests*, which stay
  labelled `MODEL CLAIM` inside the plan until a human states them.
- **Deterministic:** URL/repo parsing; policy compilation; criteria derivation;
  plan validation and provenance; worktree creation; command execution and
  exit-code capture; verification gates; diff scope analysis; secret scanning;
  evidence mapping; final status computation.

Model output crosses the boundary only through Zod-validated schemas, and only
gets as much authority as the schema has a field for — which is why the plan
schema has no status, evidence or confidence field to fill in. The reviewer may
critique but is never allowed to silently edit code.

## 4. Trust boundaries

| Boundary      | Untrusted side                              | Enforced by                                        |
| ------------- | ------------------------------------------- | -------------------------------------------------- |
| Model output  | BharatCode text/JSON                        | Zod schemas; closed criterion-id list; argv-only commands; controlled repair; fail-safe |
| Repository    | File contents, CI/lint/test config, docs    | Policy compiler treats text as data, not authority |
| Issue/comments| Body text, filenames, comments              | Authority hierarchy; prompt-injection defence      |
| Filesystem    | Any write target                            | Path must resolve inside authorized workspace      |
| Process       | Commands to run                             | argv arrays, no `shell:true`, timeout, bounded out |
| GitHub        | Any remote mutation                         | Explicit human approval gate                       |
| BharatCode    | Endpoint/credentials                        | Env-only config; central redaction                 |

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

Built today: `INTAKE → DISCOVERY → CONTRACT → PLAN`, one command each
(`issue`, `inspect`, `contract`, `plan`), each writing a run record that the next
one reads. `APPROVAL` onward is **[DESIGNED]** — which is why a `PLAN`-stage
record stops with `nextStage` naming what does not exist yet rather than
implying a run continues.

Explicit bounded limits: agent steps, tool calls, repair attempts, repeated
identical failures, request/token budget, per-command runtime, and output size.
If progress stalls, the run **stops with evidence** rather than burning requests.

## 6. Layered modules

```
src/
  core/        AppError hierarchy, status enums,         [IMPLEMENTED]
               bounded argv-only process runner
  security/    central secret redaction, path             [IMPLEMENTED]
               confinement, injection signalling
  config/      env-only configuration loading            [IMPLEMENTED]
  bharatcode/  BharatCodeClient + HTTP adapter, schemas, [IMPLEMENTED]
               retry, timeouts, cancellation
  cli/         command surface, rendering, doctor,        [IMPLEMENTED]
               issue (intake only), inspect, contract,
               plan, exit codes
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
  git/         worktree / base SHA / safe workspace      [PLANNED]
  process/     risk-classified tool controller           [PLANNED]
  verification/deterministic verification engine         [PLANNED]
  review/      independent diff reviewer wiring          [PLANNED]
  evidence/    evidence pack + report renderer           [PLANNED]
```

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
