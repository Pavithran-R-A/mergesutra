# MergeSutra v0.1.0 Production Qualification

**Decision: PRODUCTION_GA_BLOCKED.**

Qualification date: 10 November 2026.

## Release identity

| Item | Value |
|---|---|
| Current main candidate | 7436c63e8dc7d248ef713a56c2e4ca0284cfc31c |
| Release guard PR head | 4eda9ad10965d9a45ec7a14822a30319ae7cac18 |
| Package | mergesutra@0.1.0 |
| Release tag | None |
| Branch | main; PR #81 remains draft |
| Local host | Windows, Node v24.22.2, npm 11.19.1 |

PR #81 remains open and mergeable. It has no recorded review decision. Its exact head has six hosted CI passes. Its customer workflow passed eight journeys. These results do not qualify unmerged code.

## Gate matrix

| Gate | Result | Source SHA | Evidence | Blocker |
|---|---|---|---|---|
| G1 Build integrity | PASS | 4eda9ad | [CI run 42700112074](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42700112074); local build/typecheck passed | One local stress timeout |
| G2 Cross-platform behavior | PASS | 4eda9ad | Six CI cells: Ubuntu, Windows, macOS; Node 22 and 24 | Docker host coverage differs |
| G3 Sandbox isolation | BLOCKED | 7436c63 | [Sandbox limits](../SANDBOX_EXECUTION.md) | Docker unavailable locally; Git gates fail closed; macOS Docker unmeasured |
| G4 Filesystem security | BLOCKED | 7436c63 | src/security/writer.ts; tests/security/toctou-window.test.ts | Final check-to-rename race remains |
| G5 Model integration | BLOCKED | 7436c63 | [Live procedure](../REAL_MODEL_E2E_PROCEDURE.md); issues #6 and #72 | No current-source run; credits lack approval |
| G6 AI reliability | BLOCKED | 7436c63 | tests/benchmark/oracles.test.ts passed offline controls | Ten real tasks remain unrun |
| G7 GitHub publication | BLOCKED | 7436c63 | Local publisher suite passed | No authorized disposable-repository run |
| G8 Package distribution | BLOCKED | 7436c63 | Package verification and artifact tests passed | Registry package unavailable; Node 22/24 consumers untested |
| G9 Credential security | BLOCKED | 4eda9ad | Package scans, boundary tests, artifact tests passed | No current-SHA live artifacts exist |
| G10 Operational reliability | BLOCKED | 4eda9ad | Resume, interruption, locking, timeout tests passed | Local stress timeout; resource envelope unmeasured |
| G11 Release integrity | BLOCKED | 7436c63 | No GitHub releases; no publish runs | No package, tag, provenance, or release |
| G12 Documentation | BLOCKED | 7436c63 | Release and security documents inspected | Ruleset lacks required reviews and checks |

## Executed evidence

Commands ran from the PR #81 worktree.

| Command | Result |
|---|---|
| npm ci | PASS; 14 development advisories reported |
| npm run check | FAIL; 3,002 passed, 12 skipped, one timeout |
| npm audit --omit=dev --audit-level=high | PASS; zero runtime vulnerabilities |
| npm audit --json | FAIL; 10 moderate, two high, two critical |
| npm run qualify:path-shapes | PASS; Windows path-shape checks |
| npm run verify:package | PASS; 115 tests |
| npm run test:artifact | PASS; 15 installed-artifact tests |
| npm pack --dry-run | PASS; prepack scans passed; 492 files |
| Focused timeout test | PASS; 7.65 seconds |
| Docker daemon check | BLOCKED; Docker unavailable |

The full suite timed out once. The case was in tests/pr/github-publisher.test.ts. It checks read-back budget refusal. It exceeded 30 seconds in the 666-second suite. The same test passed alone in 7.65 seconds. Results suggest host contention, not product failure. No timeout changed.

Hosted evidence for PR #81:

- [Six-platform CI](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42700112074): 6/6 passed.
- [Customer workflow](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42700111841): 8/8 passed.

Main evidence, SHA 7436c63:

- [Main CI](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42694415774): 6/6 passed.
- [Main customer workflow](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42694470988): passed.

Offline benchmark controls rejected bad patches. They accepted complete fixture changes. No real-model benchmark ran.

## Security and release findings

The active protect-main ruleset blocks deletion. It also blocks non-fast-forward updates. It requires no PR, review, or passing check. PR #81's “protected main” claim exceeds verified settings.

The release guard checks tag and event identity. It checks repository and checkout identity. It checks the peeled tag and remote main SHA. Tests exercise the pure identity parser. No subprocess test covers hostile Git URL rewrites. Independent review found no confirmed bypass. That scenario remains unqualified.

The writer rechecks containment before rename. The final race remains documented. Existing tests narrow the window. They do not eliminate it.

The sandbox is bounded and fails closed. Its documented 512 MiB limit caused prior TypeScript exits. Git-backed verification cannot read linked-worktree metadata. The single bind mount withholds it. macOS Docker remains unmeasured.

The registry lookup for mergesutra@0.1.0 returned E404. No GitHub release or publish run exists. Package ownership remains unverified. First publication and provenance remain unverified.

Current npm docs require npm CLI 11.5.1+. They require Node 22.14.0+. Trusted publishers require GitHub-hosted runners. They also require exact workflow binding. OIDC publishing creates provenance automatically. See [trusted publishers](https://docs.npmjs.com/trusted-publishers/) and [provenance statements](https://docs.npmjs.com/generating-provenance-statements/).

## Remaining approval gates

No new BharatCode request was made during this audit.
No external customer PR was created.
No package, tag, or release was published.

Owners must authorize these actions:

1. Ruleset changes requiring reviews and CI.
2. Normal review and merge of PR #81.
3. One current-source run, capped at 12 completions.
4. Ten-task model benchmark budget.
5. Disposable GitHub publication test.
6. First npm publication and ownership checks.
7. Trusted Publisher setup and release publication.

No model cost is quoted. Current eligibility and pricing remain unverified.

## Production decision

PRODUCTION_GA_BLOCKED

G3 through G12 lack mandatory passing evidence. Do not publish v0.1.0. Do not claim production qualification.

## Exact-head reconciliation — 10 November 2026

This addendum replaces older PR #81 check claims.

| Item | Current evidence |
|---|---|
| Main | `7436c63e8dc7d248ef713a56c2e4ca0284cfc31c` |
| PR #81 head | `f48b0f5c7772ad3c752e772903cb0dd920005a88`, open and draft |
| PR #81 CI | PASS 6/6: [run 42784965793](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42784965793) |
| PR #81 customer workflow | PASS 8/8: [run 42784965462](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42784965462) |
| PR #82 report head | `b35863554ddc7e85374a274df0db23c850a1b2e7`; its passing checks describe that older report-only head |

PR #81's earlier CI missed one fixture.
Each disposable repo now gets local hooks.
Seals precede repository commits.
A hostile inherited hook does not execute.
Inventory now names the fixture.
Removing its seal triggers the negative control.
URL rewrite attacks remain covered.
Independent review found no security blocker.

Exact-head local evidence for `f48b0f5`:

| Command | Result |
|---|---|
| `npm ci` | PASS; 157 packages installed; 14 development advisories reported |
| `npm run format:check` | PASS |
| `npx vitest run tests/security/hook-firing-verbs.test.ts tests/security/release-git-url-isolation.test.ts` | PASS; 27 tests |
| `npm run check` | FAIL locally; first run had three timeouts, all three passed individually; second run had 84 failures across 12 files after Windows reported `ENOSPC` |
| `npm run qualify:path-shapes` | PASS on Windows |
| `npm run verify:package` | PASS; 115 tests |
| `npm run test:artifact` | PASS; 15 tests |
| `npm audit --omit=dev --audit-level=high` | PASS; zero production vulnerabilities |
| `npm pack --dry-run` | PASS; 492 files; prepack security checks passed |
| `git diff --check` | PASS |

Windows started with only 9.8 MB free.
Fixture writes produced explicit `ENOSPC` errors.
The suite ended with 376 MB free.
The local full suite is not clean.
Isolated timeouts do not indicate product defects.
All three isolated cases passed individually.
This audit changed no timeouts.

One prior PR #81 assertion was relaxed from 25s to 45s.
Its measured Windows runtime was 34.6s.
The same test measured 34.8s locally.
Its file-local hook ceiling is 60s.
This remains bounded and catches hangs.
No product request or workflow deadline changed.

Offline benchmark oracle tests passed twice.
They exercised ten oracles against three patch states.
This does not count as real-model evidence.
Production gates remain blocked: G3–G12.
No new model requests or external customer PRs occurred during this audit.
No ruleset change, release or merge occurred.

PR #81's exact head passes both hosted gates.
Independent human review remains unresolved.
Do not merge without authorized review.
Older PR #82 checks cannot qualify this source.

## Historical credentialed run evidence

[Run 42497165107](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42497165107) used source SHA `801aab0de847db4d5237a68b5f3d195aaaa62afc`.
The authenticated catalog listed `qwen-3.8-27b`.
The requested model's response did not finish.
Planning stopped after the 290000 ms timeout.
The run failed before review or repair.
No independent acceptance result was recorded.
No post-run baseline comparison was recorded.
The sanitized artifact reports no output leak.
An additional scan found zero credential-shaped files.
It scanned all thirteen downloaded artifact files.
The artifact does not record exact ledger count.
Workflow configuration set twelve requests, zero retries.
The response model identity remains unverified.
No retry or new credentialed run occurred.
This run does not qualify current `main`.

Evidence: [run artifact](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42497165107/artifacts/13624078273).

## Proposed main ruleset

Current rules block deletion and force-push.
They require no reviews or checks.
Do not change rules without owner approval.

Proposed rules require pull requests before merging.
Require one independent approval where practical.
Dismiss stale approvals and resolve conversations.
Require these exact CI checks:

| Required check name |
|---|
| `check (ubuntu-latest, node 22.x)` |
| `check (ubuntu-latest, node 24.x)` |
| `check (windows-latest, node 22.x)` |
| `check (windows-latest, node 24.x)` |
| `check (macos-latest, node 22.x)` |
| `check (macos-latest, node 24.x)` |
| `eight customer journeys, hosted` |

Solo maintenance needs an independent reviewer.
Do not enable approval lockout without one.
Preserve deletion and force-push protections.

## Hackathon listing check

The public event page lists MergeSutra.
Its card links the expected GitHub repository.
The card does not show its category.
Issue #72 cites an earlier category screenshot.
That screenshot was unavailable during this audit.
The account-side category remains unverified.
The project file `BharatCode.txt` exists on main.

Source: [BharatCode Build League page](https://auth.bharatcode.ai/hackathon).
