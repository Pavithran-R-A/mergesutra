# Demonstration

**Scripted-model demonstration.** The model is a deterministic local HTTP stand-in
(`scripts/lib/scripted-gateway.mjs`). It answers the same request the BharatCode
adapter sends; every other byte on screen is produced by `dist/bin.js`, real Git,
and the repository's own gate inside the digest-pinned container. This proves the
workflow, the consent boundaries and the evidence chain. It does not prove model
quality or BharatCode latency; the dated real-model run is separate live evidence
with its own SHA and limitations (README, "Live-model evidence").

The subject is the public fixture
[`Pavithran-R-A/mergesutra-e2e-fixture`](https://github.com/Pavithran-R-A/mergesutra-e2e-fixture),
issue #1: `slugify` keeps leading and trailing hyphens, and the issue fixes five
checkable criteria. The fixture declares one gate of its own, `npm test`; the
product adds its own `git diff --check`, so the verification plan holds two. The
journey is short enough to watch and every step is observable.

The journey stops after `pr --approve <digest>`. `pr --publish` is named by the
product as the next step and is deliberately never invoked: no branch is pushed
and no draft pull request is opened.

## Prerequisites

- Node.js 22 or newer, Git, and Docker.
- The pinned image already present:
  `node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7`
- A built CLI: `npm run build` (creates `dist/bin.js`).
- Network access for the public clone. The fixture declares no dependencies, so
  no install step runs.
- On Windows: Git Bash, and `MERGESUTRA_DOCKER_EXECUTABLE` set to the absolute
  `docker.exe` path if `where docker` does not find it.

## Run

Use an output directory outside the repository. A neutral path keeps the
operator's home directory out of the capture:

```bash
npm run build
node scripts/demo-scripted-journey.mjs --out "C:/demo/mergesutra-evidence"
```

The driver takes a few minutes on this host: the fixture's own gate is
`npm test` (`node --test`), the plan adds the product's `git diff --check`, and
Docker start-up dominates.

It writes:

| File | What it is |
| --- | --- |
| `transcript.txt` | Every screen the production CLI printed, in order, plus the harness's own labelled observations |
| `summary.json` | Structured facts: run id, base SHA, stages and exit codes, gates, criterion statuses, review findings, readiness rows, digest, damage check |
| `PROCEDURE.md` | The generated copy of this procedure |
| `logs/NN-*.log` | One raw stdout/stderr capture per command |
| `fixture/` | The real clone the run operated on, including the run's confined worktree |

The run records themselves are written by the CLI into the repository it is
invoked from — `.mergesutra/runs/<id>.json`, a path `.gitignore` already
excludes — so `fixture/` holds the clone and its worktree only. The damage check
measures the clone's tracked bytes and status before and after; the repository's
tracked tree is not a subject of the run and is left alone.

The harness fails on any contradiction: a missing outcome word, a nonzero exit
where zero is required, a review finding, a readiness row that is not `INFO` or
`PASS` after approval, changed tracked bytes in the primary clone, or a dirty
clone. A failure writes `failure.json` and stops.

## A completed run

The run this submission describes completed on 21 October 2026:

| Fact | Value |
| --- | --- |
| Run id | `run-20261021T115401Z-ea10b8` |
| Source tree | `eba29b7d02bcf9c8ef0b8e7a898a0a9dc6aab70f`, CLI `0.1.0` |
| Fixture base | `6f3a0adb17389b93fd76b95c21a1c9eb7b161998` |
| Model turns | 6 requests from the deterministic gateway (plan 1, implement 4, review 1) |
| Implementation | `COMPLETED_BY_MODEL`; 2 files, 1004 bytes, budget 4/8 steps · 2/4 writes · 1/3 checks |
| Gates | `VG-001 npm test` exit 0; `VG-002 git diff --check` exit 0; verdict `PASS` |
| Independent oracle | `ORACLE-AC-1` … `ORACLE-AC-5` all `PASS`, measured from the worktree |
| Review | 0 findings, no repair plan (`REVIEW_RECORDED`, exit 3) |
| Readiness | 7 `INFO` + `WARN human-approved`, then 8 `INFO` after approval |
| Approval digest | `46e27c326c4b9d5f015e8b0de015c03944516e1e46fccaff025a20fee067163e` |
| Publication | Approval recorded; `--publish` never invoked; no branch pushed, no PR opened |
| Customer damage | Primary clone tracked bytes unchanged; status clean |

The product's own criterion rows stay `NOT_AVAILABLE` /
`MANUAL_REVIEW_REQUIRED`: the fixture issue asks a person to check its inputs,
and no gate in the product stands in for that person. The independent oracle is
the harness's measurement of those same inputs, kept separate from the product's
claim on purpose.

## The transcript-cut video

An 88-second MP4 was produced from this run for the submission. It is a
**transcript cut, not a screen recording**: each displayed line is either
selected from the run's `logs/` or `summary.json` by a helper that refuses a line
the evidence does not contain (`line()`, `oracleLine()`), or is a layout label or
a transcription of a recorded value written into the generator. A sanitized copy
of `transcript.txt` is published beside the public video copy, so every
fact-bearing line can be checked against the run. A persistent banner labels the
model **SCRIPTED**. The
thirteen recorded CLI stages took about 25 seconds in this run, so there are no
long waits to condense; each slide simply holds a real line set long enough to
read.

The public copy of the cut is
[`docs/assets/merge-sutra-demo-88s.mp4`](assets/merge-sutra-demo-88s.mp4)
(1,605,962 bytes, 87.97 s, sha256
`37846e5433ee263b6fdeae663719d6a5fddb554362ad221e4e6b06331fb5ace0`), with the
sanitized transcript at
[`docs/assets/merge-sutra-demo-transcript.txt`](assets/merge-sutra-demo-transcript.txt).
The transcript is the run's own file with 29 operator-path strings replaced
mechanically: the evidence root becomes `<scripted-demo-evidence>` (19
occurrences) and the run-record directory becomes `.mergesutra/runs/` (10
occurrences); every other byte is unchanged. The generator and the full evidence
bundle remain beside the evidence, outside the repository.

If you prefer a terminal recording on a machine with a display:

1. **Preparation.** Use a neutral output path (`C:/demo/...`), close notification
   popups, and set the terminal to at least 120×40 with a 16 px or larger font.
   Run the full command once to warm Docker and the npm cache, then delete that
   output directory and record a fresh run.
2. **Continuous capture.** Record the whole run at 1080p. Do not splice a command
   to an output it did not produce. The fixture's own gate is a single `npm test`,
   so the verification segment is short; if you speed it up, do so uniformly and
   with a visible "verification running" title. Never replace it with a
   fabricated PASS.
3. **Permanent label.** Keep a "Scripted-model demonstration" overlay visible for
   the entire video. Do not label it as live BharatCode.
4. **The produced 88-second cut.** The video follows these sections from
   `transcript.txt`/`summary.json`:
   - 0:00 title, tagline, scripted-model label
   - 0:06 `issue` and `inspect` — fixture issue #1 and the pinned base commit
   - 0:13 `contract` — the acceptance criteria, all `PENDING`
   - 0:21 `plan` — proposals only; nothing executed
   - 0:28 `implement` — the bounded loop, allowed actions and the confined worktree
   - 0:36 `verify` — the consent probe refuses without `--allow`
   - 0:44 `verify --allow VG-001` — both gates, `VERIFICATION_PASS`
   - 0:51 independent acceptance evidence — the harness's own measurement of the patch
   - 0:58 `review` — zero findings, no repair plan
   - 1:04 `pr` — the page, the 64-hex digest, `NOT_READY_FOR_PUBLICATION`
   - 1:12 `--approve` — `HUMAN_APPROVED_FOR_PR` and the "no remote change" boundary
   - 1:20 close — run id, digest, clean clone, and the separate live-model run
5. **Sanitisation.** The harness redacts credential-shaped strings. Check the
   final frames for local usernames or unrelated window titles; crop or blur
   them. Publish `transcript.txt` beside the video so a judge can verify the cut
   came from the run.

## What the evidence shows

- The same production binary that ships from this repository produced every
  screen and exit code.
- A human consent is required before any repository gate runs; the probe exits
  `4` and lists the gates.
- Acceptance evidence is measured independently of the product's own claim.
- A review with zero findings still exits `3`: it is a receipt, not a verdict.
- The publication page binds one 64-hex digest; approving it records a decision
  and reports that no remote was touched.
- The primary clone's tracked bytes are unchanged before and after.

The real-BharatCode path is evidenced by
[run #38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041)
on commit `b1c18bfaf299dfae6316b70e17647a6bde48caee`; that run predates the
current tree and proves one bounded fixture task, not general reliability.
