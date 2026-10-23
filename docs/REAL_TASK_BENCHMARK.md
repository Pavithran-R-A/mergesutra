# MergeSutra — independent real-task release benchmark

**Status: NOT EXECUTED.** This is an operator protocol and evidence ledger, not a test result.
Do not mark the real-task benchmark as passing from the Stage 14 slugify qualification alone.

## Baseline evidence (separate from this benchmark)

- Controlled run [#38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041), exact source SHA `b1c18bfaf299dfae6316b70e17647a6bde48caee`, completed on 11 October 2026.
- `qwen-3.8-27b`, nine observed completions of twelve allowed; independent fixture check passed; no reviewer findings.
- The bounded demo produced a **local PR candidate**, not a published PR. Its readiness was `NOT_READY_FOR_PUBLICATION`.
- This **one** test is the prerequisite for the benchmark, not one of its ten independent test cases.

## Safety prerequisites before spending credentials or model requests

1. Pin a precise source SHA, model ID, task issue and fixture base SHA. Do not mutate `main` or reuse a modified fixture from an earlier task.
2. Use distinct temporary/throwaway repositories or private local clones with issues and human-readable criteria. Never test on a customer's actual repo or push a model patch without explicit approval.
3. **Do not run arbitrary repository commands with the BharatCode secret in their process environment.** The process runner strips common credentials, but worktrees and environment filters are not OS-level isolation; require sandboxed execution with least-privilege filesystem, process, network, and credential access before using untrusted repositories.
4. Provide an independent, pinned acceptance oracle not editable by the model (outside its writable worktree). Preserve original test assertions and use negative controls: the checker must fail on the unfixed base and on intentionally incomplete patches.
5. Limit model completion requests, elapsed time, output size and permitted writes per run; stop on any unexpected remote mutation attempt, artifact credential match, cross-task leakage, or missing independent oracle.
6. Record the full cost/request envelope from the provider separately from the model's own claims. One authenticated catalog HTTP 200 is not proof that an implementation succeeded.

## Ten distinct test classes to implement and execute

Each row below requires its **own** pinned fixture, issue, independent oracle and results. The fixtures and their offline controls now exist (see below), but no class has been run: the benchmark status remains **NOT EXECUTED**.

| Case | Representative issue class | Independent pass proof |
| --- | --- | --- |
| B01 | String normalization edge cases | Correct results for multiple unseen whitespace/punctuation inputs; preserved original tests |
| B02 | Input validation of malformed values | Direct negative/positive calls and exact error contract |
| B03 | CLI argument and help regression | CLI exit codes, stdout/stderr contract, both Node 22 and 24 |
| B04 | Async timeout or cancellation defect | Bounded subprocess proves cancellation and no lingering child |
| B05 | Structured data serialization mismatch | Cross-check parsed round trips, escaped values and unchanged format |
| B06 | File path safety boundary | Outside-root and symlink attempts independently refused |
| B07 | Configuration precedence bug | Clean-env subprocesses cover missing/overridden values and no leaked key |
| B08 | Multiple-file bug with existing regression suite | Both related files corrected, original assertions maintained |
| B09 | Previously green but insufficient test coverage | Negative control catches a subtly wrong patch; new tests must be effective |
| B10 | Reviewer catches an incomplete fix and repair succeeds | Evidence includes first rejection, digest-bound approval and verified rerun |

At least two distinct fixture repositories and at least three distinct issue types must be used. A model-created check file is **never** the only oracle. A refusal, inconclusive result, regression, or budget expiration is a **failure in the corresponding row**, not an omitted result.

## Required row evidence (repeat for B01–B10)

- Source SHA, issue URL, fixture repository and base SHA; model ID and recorded provider response provenance.
- Number of plan/implementation/review/repair calls, per-run ceiling and wall-clock duration; actual token usage where reported.
- Model conclusion, changed paths and limits; checks executed with command, exit code and patch digest.
- Independent check results for requested behavior, required new assertions, baseline assertion preservation, dependency policy and scope.
- Independent negative-control result on base and intentionally incorrect patch.
- Reviewer findings, any repair plan/approval and repeat verification; original tests preserved.
- Secret and artifact scan summary, credential handling, any remote action, and whether a PR was actually published.
- Outcome: `PASS` / `FAIL` / `BLOCKED` / `INCONCLUSIVE`, with exact log/run/artifact URLs.

## Go / no-go rule

All ten rows must have independently verified PASS with zero credential leaks, unauthorized remote changes, or unexplained test-assertion removals before claiming the ten-task benchmark gate is met. Failures remain visible; fixes require fresh exact-SHA runs, never editing past evidence. Even ten PASS rows do **not** prove full sandboxing, comprehensive security, real-customer reliability or public release readiness.

A separate release decision must also verify OS-level trust isolation, manual operator approvals, a real 60–90 second captured run, first npm ownership/2FA and Trusted Publishing, verified `mergesutra@0.1.0` in the registry, matching GitHub `v0.1.0` release, and account-linked hackathon submission.

## Offline fixtures and oracle controls (prepared 2026-10-23)

[`fixtures/benchmarks/`](../fixtures/benchmarks/README.md) now holds one repository, issue,
independent oracle and two control patches per class. None of that is a run: the fixtures were
built without a model call, and the ledger below stays `OPEN`.

`scripts/benchmark-oracles.mjs` materialises each fixture three times in a scratch directory
outside the checkout:

| copy | baseline suite | independent oracle |
| --- | --- | --- |
| base | pass | **fail** |
| reference (complete fix) | pass | **pass** |
| wrong (plausible incomplete fix) | pass | **fail** |

Six expectations per case, ten cases. `tests/benchmark/oracles.test.ts` runs the whole battery
and additionally asserts that no oracle, `case.json`, `reference/` or `wrong/` file sits inside
the model-visible `repos/` tree. A passing battery means each oracle can discriminate; it does
**not** count toward the ten required PASS rows, which need pinned SHAs, real model requests and
recorded provider usage.

B03 requires both Node 22 and Node 24; the offline controls were exercised on the repository's
local Node runtime only. The Node 22 leg and every model-facing leg remain part of a real run.

## Results ledger

| Case | Fixture/issue | Run or artifact | Independent result | Status |
| --- | --- | --- | --- | --- |
| B01 | Not selected | None | Not evaluated | OPEN |
| B02 | Not selected | None | Not evaluated | OPEN |
| B03 | Not selected | None | Not evaluated | OPEN |
| B04 | Not selected | None | Not evaluated | OPEN |
| B05 | Not selected | None | Not evaluated | OPEN |
| B06 | Not selected | None | Not evaluated | OPEN |
| B07 | Not selected | None | Not evaluated | OPEN |
| B08 | Not selected | None | Not evaluated | OPEN |
| B09 | Not selected | None | Not evaluated | OPEN |
| B10 | Not selected | None | Not evaluated | OPEN |

**Do not replace an OPEN row with a successful description unless the actual evidence is accessible and immutable.**
