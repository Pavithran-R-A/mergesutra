# MergeSutra release qualification — 10 November 2026

## Verdict

**BLOCKED for full release qualification.** The code candidate passes
deterministic, package, artifact, path, cross-platform, and scripted customer
gates. The current-SHA live model run remains unexecuted. The independent
ten-task benchmark remains `NOT_EXECUTED` (0/10). No model requests were spent
for this qualification.

This is not a production-readiness claim. Submission assets are technically
ready. The account holder must verify contest-entry status before the deadline.

## Qualified source revisions

- Code candidate `main`: `a381ff064873f631da7bc86783d2a197fb03af8b`.
- PR #79 updated documentation only.
- Its merge changed `main` to `b723c011973116cb3d7693aacee5fde43f80bf83`.
- Fresh CI and customer checks passed there.
- No source files changed after the code candidate.
- PR #77 merged as `fda2615c03c856debcf2bea9bc63da9f47b367ab`.
- PR #78 merged as `a381ff064873f631da7bc86783d2a197fb03af8b`.
- PR #78 head: `a48f2d53b61dc35a69ed58d951315630b80d5106`.
- PR #78 was retargeted to `main`.
- Its update preserved remote history.
- It was merged normally after review.

## Hosted evidence

| Gate | Result | Evidence |
| --- | --- | --- |
| Ubuntu, Node 22 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| Ubuntu, Node 24 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| Windows, Node 22 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| Windows, Node 24 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| macOS, Node 22 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| macOS, Node 24 | PASS | [Main CI #42677315458](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677315458) |
| Eight scripted customer journeys | PASS | [Main #42677463193](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42677463193) |
| Documentation-only `main` revision | PASS | [CI #42684494407](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42684494407), [customer #42684569891](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42684569891) |
| PR-head matrix and customer gate | PASS | [CI #42675078631](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42675078631), [customer #42675078865](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42675078865) |

The PR-head jobs tested `a48f2d5`.
The merged-main jobs tested `a381ff0`.
The customer workflow uses a scripted model.

## Local release gates

Windows 10.0.26200; Node `v24.22.2`; npm `11.19.1`.
The working directory was the PR #78 worktree.
TMP/TEMP resolved to the user temp directory.
Vitest used repository defaults without overrides.

| Command | Result |
| --- | --- |
| `npm ci` | PASS |
| `npm run check` | First full run passed: 2,997 passed, 12 skipped; later contention rerun failed |
| `npm run qualify:path-shapes` | PASS: Windows path cases |
| `npm run verify:package` | PASS: 115 tests |
| `npm run test:artifact` | PASS: 15 tests |
| `npm audit --omit=dev --audit-level=high` | PASS: zero production vulnerabilities |
| `docker version --format '{{.Server.Version}}'` | BLOCKED locally: Docker daemon absent |

Hosted customer qualification passed in Docker.
The Windows-local result supplements hosted matrix evidence.
The 12 skipped tests remain disclosed.

A later Windows rerun exposed resource-sensitive limits.
It reported nine timed-out tests and 37 skips.
The ten-oracle subprocess exceeded its 180-second limit.
The live fixture harness exceeded its 45-second measurement.
Its isolated rerun measured 54.864 seconds.
Publisher, verification, and repair tests timed out.
No timeout was raised or skip added.
The exact-source hosted matrix still passed 6/6.
See [main CI #42684494407](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42684494407).

## Confirmed corrections

PR #78 initially failed formatting.
`scripts/e2e-validation.mjs` had a multiline import Prettier rejected.
The import was formatted with the pinned formatter.

TypeScript then found missing declarations for two `.mjs` modules.
Added local declarations and explicit test callback types.
Updated source-shape assertions for both fixture profiles.
The assertions now check the actual profile routing.

The full local run had four failures.
Two were stale source-shape assertions, now corrected.
The timing oracle passed its focused rerun.
It also passed during the full rerun.
Its 45-second guard was not raised.
The Git fixture timeout passed focused and full reruns.
No product timeout was increased or suppressed.

Files changed by PR #78:

- `.github/workflows/live-validation.yml`
- `scripts/e2e-validation.mjs`
- `scripts/lib/compact-qualification.mjs`
- `scripts/lib/compact-qualification.d.mts`
- `scripts/lib/live-qualification.mjs`
- `scripts/lib/live-qualification.d.mts`
- `tests/security/compact-live-qualification.test.ts`
- `tests/security/live-validation-workflow-policy.test.ts`

## Security and model qualification

The live workflow remains manual-dispatch only.
The live job requires `refs/heads/main` and `run_live=true`.
The selected model must appear in the authenticated catalog.
Repository commands remain inside the pinned Docker sandbox.
Repository commands receive no model credential.
The completion ceiling remains 12.
Automatic retries remain zero.
The workflow rejects rerun attempts before credentials are used.
Artifacts contain sanitized driver exports only.
The workflow has no PR, push, or merge step.

The compact profile uses public fixture issue #1.
Its independent oracle remains outside model write scope.
Regression tests reject incomplete assertions and forbidden paths.
They also reject dependencies and a failing oracle.
Compact evidence cannot satisfy full-profile path requirements.

No live workflow was dispatched here.
No BharatCode request or paid infrastructure was used.

Historical live evidence remains separate:

- [Successful Qwen run #38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041) used old SHA `b1c18bf`; it consumed 9/12 requests and passed its independent fixture check.
- [Full run #42497165107](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42497165107) failed planning on `801aab0`; no implementation or review followed.
- The newer compact profile has no live result.
- The ten-task benchmark remains `NOT_EXECUTED`, 0/10.

## Submission and remaining limits

- Repository visibility: PUBLIC.
- `BharatCode.txt`: present on `main`.
- The 88-second demo link returned HTTP 200.
- The demo remains explicitly scripted, not live.
- No separate project-overview video was found.
- The official rules document no video requirement.
- The owner reported an existing contest entry.
- This environment cannot inspect account-linked status.
- The npm package remains unpublished.
- macOS Docker-host behavior remains unqualified.
- The writer retains a final-check-to-rename race.
- Real remote draft-PR publication remains unqualified.
- Full profile on this exact SHA remains unqualified.

Verify the existing entry at the
[official Build League page](https://bharatcode.ai/hackathon).
