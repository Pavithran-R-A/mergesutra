# MergeSutra

### AI can propose a fix. MergeSutra demands evidence.

**Issue in. Evidence-backed PR out.** An open-source, BharatCode-powered coding agent that takes a GitHub issue through bounded code changes, executed checks, and traceable acceptance evidence—then leaves draft pull request publication in human hands.

> **Build League supporters:** [Vote for MergeSutra on BharatCode](https://bharatcode.ai/hackathon#projects) (search **MergeSutra**; one genuine registered-account vote per person) · [Star the GitHub repo](https://github.com/Pavithran-R-A/mergesutra) if you find it useful · [Watch the 88-second demo](docs/assets/merge-sutra-demo-88s.mp4) (scripted model, production CLI).

**A model's confidence is not a test result. If a requirement wasn't verified, MergeSutra tells you.**

[![CI](https://github.com/Pavithran-R-A/mergesutra/actions/workflows/ci.yml/badge.svg)](https://github.com/Pavithran-R-A/mergesutra/actions/workflows/ci.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

**Judges: [Watch the 88-second demo](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/assets/merge-sutra-demo-88s.mp4) · [Inspect the proof](#proof-not-promises) · [Open the two-minute judge guide](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/JUDGE_GUIDE.md)**

Built for BharatCode's model API, MergeSutra is a **standalone CLI**, not an already-shipped BharatCode Desktop/IDE plugin or official editor integration.

## In 30 seconds

**The problem:** An AI can generate a plausible patch in seconds. The maintainer still needs to ask: *Did it actually satisfy the issue? What ran? What wasn't tested? Is the patch safe to share?*

**The approach:** MergeSutra converts a GitHub issue and repository policy into an **Acceptance Contract**, lets BharatCode propose bounded changes, executes allowed checks in a locked-down container, and maps criteria to verifiable results. A second model reviews the exact patch. A person must approve the digest of the PR page; publication is a separate, explicit step.

| Maintainer's question | MergeSutra's answer |
| --- | --- |
| Did you understand the issue? | Named acceptance criteria and a verification plan |
| What changed? | A recorded patch in an isolated Git worktree |
| What passed or failed? | Executed gate receipts and per-criterion evidence, including missing or inconclusive checks |
| Who decides to publish? | A human who approves the exact page before a separate draft-PR action |

**One mission, not another general coding chatbot:** **Issue → contract → patch → executed checks → evidence → review → human-approved draft PR.**

## Watch the workflow

[**▶ Watch the 88-second demonstration (scripted model, real production CLI)**](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/assets/merge-sutra-demo-88s.mp4)

The demonstration drives the compiled CLI against a real [public fixture issue](https://github.com/Pavithran-R-A/mergesutra-e2e-fixture/issues/1). It exercises intake, planning, edits, verification, evidence, review and digest approval. A **scripted local model gateway** supplies the AI responses, clearly labeled throughout. It proves the controlled workflow, **not** live-model quality, current-model latency or remote publication. No branch is pushed.

[Reproduce the run and inspect its logs](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/DEMO.md).

## Quick start

Requires **Node.js 22 or 24**, Git, and authenticated [GitHub CLI](https://cli.github.com/) for issue intake. Repository-owned commands additionally require Docker with a **digest-pinned image already present locally**; no host-execution fallback.

The npm package is **not published**. Run the CLI from source:

~~~bash
git clone https://github.com/Pavithran-R-A/mergesutra.git
cd mergesutra
npm ci
npm run build
node dist/bin.js doctor
node dist/bin.js --help
~~~

**There is no default BharatCode model.** Choose an eligible model from [BharatCode's official model page](https://bharatcode.ai/build), then set `BHARATCODE_MODEL` (for example, `qwen-3.8-27b` if available to your account). Set `BHARATCODE_API_KEY` in your own secure environment—never in a command argument, repo, screenshot or issue.

A typical guided operator sequence (use the real run ID, approved gate names and digest shown by your CLI):

~~~bash
node dist/bin.js issue https://github.com/<owner>/<repo>/issues/<number> --repo /path/to/clone
node dist/bin.js inspect /path/to/clone
node dist/bin.js contract <run-id>
node dist/bin.js plan <run-id>
node dist/bin.js implement <run-id> --max-steps 8
node dist/bin.js verify <run-id> --repo /path/to/clone
node dist/bin.js verify <run-id> --repo /path/to/clone --allow VG-001
node dist/bin.js review <run-id>
node dist/bin.js report <run-id>
node dist/bin.js pr <run-id>
node dist/bin.js pr <run-id> --approve <digest>
# A separate, human-authorized remote action; never an automatic merge:
node dist/bin.js pr <run-id> --publish
~~~

**No live-model key?** Use the [scripted replay procedure](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/DEMO.md). Real-model qualification has its own [request-capped procedure](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/REAL_MODEL_E2E_PROCEDURE.md).

## Why MergeSutra

Most coding tools optimize for **producing** a patch. MergeSutra focuses on the difficult second half: **showing what the patch actually proves**.

- **Acceptance first.** Each criterion has an ID and verification plan. Model prose cannot create a passing test result.
- **Receipts, not reassurance.** Checks are recorded with real outcomes. Unverified, failed, skipped, blocked and inconclusive criteria stay visible.
- **Bounded model actions.** BharatCode proposes actions; MergeSutra validates them against schemas, tool policy, path limits and a separate Git worktree.
- **Review, repair, recheck.** A second model reads a pinned patch. Repair has explicit digest-scoped consent and requires another verification.
- **No invisible publishing.** Human approval names one 64-hex digest; `pr --publish` alone opens a GitHub **draft** pull request. The product never force-pushes or merges.
- **State you can inspect.** `status` exposes stale records and `resume` proposes the next authorized stage without silently resetting work.

The fully unattended `mergesutra run` command is **not shipped**. Neither is an IDE extension or web dashboard.

## Proof, not promises

| Claim | Inspectable evidence | Honest boundary |
| --- | --- | --- |
| Cross-platform engineering | [Six CI jobs passed at `c6fd871`](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42492506208) on Linux, Windows and macOS with Node 22 and Node 24 | Not a live BharatCode result |
| Working customer CLI stages | [Eight hosted scripted customer journeys passed](https://github.com/Pavithran-R-A/mergesutra/actions/runs/42489888186) on PR #70's pre-merge revision | Scripted gateway; not the final merged SHA |
| Real BharatCode used successfully | [Historical Qwen fixture at `b1c18bf`](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041), 11 October: 9/12 model requests, independent acceptance passed | Older commit, one bounded fixture; no published PR |
| Isolated repository execution | [Linux Docker sandbox jobs passed](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41614337044) | Some host/command combinations remain unqualified |
| Representative AI reliability | [Ten-case benchmark ledger](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/REAL_TASK_BENCHMARK.md) | **0/10 live cases recorded** |

**Still unproven:** Full live BharatCode qualification on the present submission SHA, the ten-case reliability benchmark, real remote draft-PR publication, and macOS Docker-host behavior. The writer retains a documented final-check-to-rename race. These limits are disclosed—not hidden behind a 100% claim.

## Architecture: where trust is enforced

~~~text
GitHub issue + repository policy
                 |
          Acceptance Contract
                 |
          BharatCode AI plan
                 |
      Bounded patch in Git worktree
                 |
    Pinned, network-disabled Docker checks
                 |
   Criterion-level evidence + AI review
                 |
       Digest-bound human approval
                 |
      Explicit draft PR publication
            (never merge)
~~~

Issue text, repository contents and model responses are **untrusted data**. Repository commands run inside a digest-pinned Linux container with `--network=none`, a non-root account, read-only root and resource caps. A worktree confines changes but **is not an OS sandbox**. The publisher is wired only for explicit publication; recovery and repair boundaries have source-level tests, including `tests/repair/boundaries.test.ts`.

[Architecture](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/ARCHITECTURE.md) · [Security model](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/SECURITY_MODEL.md) · [Full judge's evidence guide](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/JUDGE_GUIDE.md)

## Configuration

Credentials come from the environment, never a CLI flag.

- **`BHARATCODE_TIMEOUT_MS` transport ceiling:** Node's fetch may fail before response headers at ~300 s with `UND_ERR_HEADERS_TIMEOUT`, regardless of a larger configured timeout. The controlled live workflow sets 290000 ms (below that transport bound); a longer setting is not a promise of longer provider patience.

| Variable | Role |
| --- | --- |
| `BHARATCODE_API_KEY` | API credential for model calls |
| `BHARATCODE_MODEL` | Required model identifier, no default |
| `BHARATCODE_API_BASE` | API base URL override (default: `https://bharatcode.ai/api/model/v1`) |
| `BHARATCODE_TIMEOUT_MS` | Request timeout |
| `BHARATCODE_MAX_RETRIES` | Retry count |
| `BHARATCODE_RETRY_BASE_MS` / `BHARATCODE_RETRY_MAX_MS` | Backoff limits |
| `BHARATCODE_MAX_COMPLETION_REQUESTS` + `BHARATCODE_REQUEST_LEDGER` | Optional **paired** completion-request ceiling and absolute-path ledger |
| `NO_COLOR` | Plain terminal output |

For a fully bounded run, use the [real-model qualification guide](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/REAL_MODEL_E2E_PROCEDURE.md). No environment variable grants remote publication permission.

## Supported repositories

- **Engineering CI:** Linux, Windows and macOS with **Node 22** and **Node 24**; six hosted cells passed at the recorded SHA.
- **Initial scope:** Public GitHub issues and a local Git clone whose repository checks are supported by the bounded discovery and execution workflow.
- **Runtime:** Repository commands require the pinned Docker image; [exact host/command qualifications](https://github.com/Pavithran-R-A/mergesutra/blob/main/docs/SANDBOX_EXECUTION.md) are documented. Green macOS CI does **not** mean Docker-host qualification on macOS.
- **Publication:** An explicitly approved **draft** PR only; no forced history update or merge.

## What a run leaves behind

MergeSutra deliberately does **not** silently delete the evidence or reset your workspace after a run. Check and preserve the changes you want before removing anything:

- **Worktrees:** Under `.mergesutra/worktrees` in the target repository. Inspect the correct run first. Only if you have saved its work and intentionally want to delete that worktree, use `git worktree remove <exact-worktree-path>` from the owning repository. If Git says it contains changes, review them rather than forcing removal.
- **Git metadata:** Inspect linked worktrees with `git worktree list`; after intentional removals, `git worktree prune` can clear stale bookkeeping. Branches beginning `mergesutra/` may remain; inspect them before deleting any branch.
- **Evidence records:** Under `.mergesutra/runs`. Preserve these records if you need to audit or reproduce a result. MergeSutra never automatically deletes them.
- **CLI installation:** This release runs from source, not a published npm package. If you previously installed a global package in another context, `npm uninstall -g mergesutra` removes that global installation; it does not delete project worktrees or run evidence.

## BharatCode Build League

**Category:** Coding & developer tools · **Format:** Standalone CLI using BharatCode's model API · **Theme:** *Build the tools India will code with.*

The public source, tests and demonstration exist so maintainers can inspect the results rather than take the AI's word for them.

[**Find MergeSutra and vote on BharatCode**](https://bharatcode.ai/hackathon#projects) · [**Star the repository if you find it useful**](https://github.com/Pavithran-R-A/mergesutra) · [**Report bugs and feedback**](https://github.com/Pavithran-R-A/mergesutra/issues)

The project is not an official BharatCode IDE integration. The [required hackathon note](BharatCode.txt) is present at the repository root.

## Contribute

Feedback, test fixtures and reproducible bug reports are welcome. Read [Contributing](https://github.com/Pavithran-R-A/mergesutra/blob/main/CONTRIBUTING.md) and [Security](https://github.com/Pavithran-R-A/mergesutra/blob/main/SECURITY.md).

MIT licensed: [LICENSE](LICENSE).
