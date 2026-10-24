# BharatCode Build League — submission pack

Source of requirements: <https://bharatcode.ai/hackathon>, read on 21 October 2026 and
re-read on 23 October 2026 (the deadline moved from 25 October to 10 November).
This file prepares the entry; it does not claim that any account-linked
submission has been made.

## Verified requirements

| Requirement | Status | Evidence |
| --- | --- | --- |
| Public GitHub repository | PASS | `gh repo view Pavithran-R-A/mergesutra` reports `"visibility":"PUBLIC"` |
| `BharatCode.txt` at the repository root | PASS | `gh api repos/Pavithran-R-A/mergesutra/contents/BharatCode.txt` returns the file at `main` |
| Built with BharatCode | PASS, with stated limits | Live run [#38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041), 11 October 2026, `qwen-3.8-27b`, commit `b1c18bfaf299dfae6316b70e17647a6bde48caee` |
| Working project | PASS | `npm run build`; completed scripted-model journey `run-20261021T115401Z-ea10b8` (2/2 gates, 5/5 oracle checks, 0 review findings); hosted CI on `main` |
| Submission form fields | READY | Name, URL and summary below |
| Submission made | **NO** | No account-linked entry exists until the organiser's site confirms one |
| Deadline | 10 November 2026, 11:59 PM IST | Must be submitted from the organiser's site by the account holder; re-verified on <https://bharatcode.ai/hackathon> on 23 October 2026 |

Eligibility: students and other builders. Judging: GitHub stars, website votes,
and judges' evaluation. No video is required by the stated rules; the
demonstration materials exist for the judges and the repository README.

## Suggested entry fields

**Project name**

MergeSutra

**Public GitHub URL**

https://github.com/Pavithran-R-A/mergesutra

**Category / track**

Coding & developer tools (CLI Agent track)

**Short summary**

MergeSutra is a BharatCode-powered CLI agent that turns a GitHub issue into a
reviewable code change, independently verifies each acceptance criterion against
real evidence, and opens a draft pull request only after a human approves the
exact page by digest.

**Longer description**

MergeSutra adds the missing layer to AI coding agents: trustworthy evidence.
It reads an issue, compiles the repository's own requirements into an acceptance
contract, asks BharatCode for a plan and a bounded sequence of file writes and
commands, then runs the repository's own gates only after a human consents by
name. Each acceptance criterion is mapped to the evidence that could actually
check it — `PASS`, `FAIL`, `SKIPPED`, `NOT_AVAILABLE`, `BLOCKED` or
`INCONCLUSIVE` — and a second model reads the exact patch for defects. The
publication page is assembled from recorded facts and bound to a 64-hex digest;
approval records a decision, and only a separate `--publish` asks GitHub for a
**draft** pull request through the operator's own `gh` login. MergeSutra never
force-pushes and never merges.

The repository command runner is a digest-pinned, network-disabled, read-only
Linux container under a non-root user; model output is untrusted,
schema-validated data. The project includes a recorded live BharatCode run from
11 October 2026 on commit `b1c18bf` (9 of 12 budgeted model requests, zero review
findings, independent fixture checks passed) and a completed scripted-model
demonstration of the full workflow at the current tree (`run-20261021T115401Z-ea10b8`:
both gates exit 0, all five independent oracle checks pass, zero review findings,
digest-bound approval filed, `--publish` never invoked). The live run predates
the current tree and proves one bounded fixture task, not general model
reliability.

## Real-model evidence, stated exactly

- Run: <https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041>
- Date: 11 October 2026
- Commit: `b1c18bfaf299dfae6316b70e17647a6bde48caee` (older than the submission tree)
- Model: `qwen-3.8-27b`
- Budget used: 9 of 12 model requests
- Outcome: `PR_CANDIDATE_RECORDED`, readiness `NOT_READY_FOR_PUBLICATION`
- Review findings: 0; fixture acceptance evidence present
- Test totals in that job: 2,368 passed, 6 skipped

Limitations: one bounded fixture task; not a ten-task benchmark, not a customer
reliability claim, and no proof of latency under the current 290-second cap.

## Demonstration

- Completed run: `run-20261021T115401Z-ea10b8`, 21 October 2026, source
  `eba29b7d02bcf9c8ef0b8e7a898a0a9dc6aab70f`, fixture base
  `6f3a0adb17389b93fd76b95c21a1c9eb7b161998`
- Gates: `VG-001 npm test` exit 0 and `VG-002 git diff --check` exit 0
- Independent oracle: `ORACLE-AC-1` … `ORACLE-AC-5` all `PASS`
- Review: 0 findings; approval digest
  `46e27c326c4b9d5f015e8b0de015c03944516e1e46fccaff025a20fee067163e`;
  `--publish` never invoked
- Video: [88-second MP4](https://github.com/Pavithran-R-A/mergesutra/blob/HEAD/docs/assets/merge-sutra-demo-88s.mp4),
  1920×1080, **transcript cut** from the run's literal
  stdout, selected and reflowed, with a persistent SCRIPTED banner; not a screen
  recording
- Transcript: [sanitized copy](https://github.com/Pavithran-R-A/mergesutra/blob/HEAD/docs/assets/merge-sutra-demo-transcript.txt)
  beside the video; 29 operator-path strings replaced mechanically, every other
  byte unchanged
- Harness: `scripts/demo-scripted-journey.mjs`
- Procedure and provenance: `docs/DEMO.md`
- The demonstration is a **Scripted-model demonstration**; the model is a local
  deterministic stand-in. It is not presented as live BharatCode.

## What the account holder still must do

1. Open <https://bharatcode.ai/hackathon> while signed in.
2. Submit the name, public repository URL and short summary above before
   **10 November 2026, 11:59 PM IST** (re-verified 23 October 2026).
3. Confirm the site shows a submitted-entry state; only that confirmation should
   be treated as a successful entry.
