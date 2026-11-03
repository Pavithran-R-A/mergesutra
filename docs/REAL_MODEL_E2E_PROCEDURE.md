# Real-model end-to-end procedure

**Status (11 October 2026): single controlled real-model fixture qualified; public
release not yet qualified.** The earlier Qwen run #38040856632 exposed lost
baseline test assertions and failed independent acceptance. After the
regression-preservation fix, controlled
[run #38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041)
on exact `main` SHA `b1c18bfaf299dfae6316b70e17647a6bde48caee`
succeeded on Ubuntu no-key, Windows no-key, and real Qwen 3.8 27B E2E.
The model made 9 of 12 budgeted completions. Independent checks proved the
three slugify behavior cases, the three added test assertions, preservation
of existing test assertions, no dependency additions, fixture-only edits,
and a passing verification script. The reviewer recorded no findings.
Its publication outcome is still `PR_CANDIDATE_RECORDED`, with
`NOT_READY_FOR_PUBLICATION` and `published=false`.
One successful controlled task does not close the representative real-task
benchmark, demonstration, OS sandbox, first npm publication, or hackathon
submission gates. See [REAL_TASK_BENCHMARK.md](REAL_TASK_BENCHMARK.md)
for the pending independent benchmark protocol. Section 4 retains the
historical no-key procedure; predictions are not passing evidence.

**Three real-model readings exist, and they are not the same claim (2 November 2026).** Each was
re-taken from its own hosted job log rather than copied forward, and each says something different:

| Date | Run | Build | What the provider did | What it proves |
| --- | --- | --- | --- | --- |
| 11 Oct 2026 | [38144174041](https://github.com/Pavithran-R-A/mergesutra/actions/runs/38144174041) | `b1c18bfaf299dfae6316b70e17647a6bde48caee` | the full `plan` → `implement` → `review` chain, 9 of 12 budgeted completions | one bounded fixture task was completed by the real model on an older build |
| 23 Oct 2026 | [39909412225](https://github.com/Pavithran-R-A/mergesutra/actions/runs/39909412225) | `cd03393c587ac0213bec6fa6a5cef00ddbef936a` | the `standard` one-request smoke, `kind=cancelled http=(none)` at 89,059 ms against the 90,000 ms clock, no usage reported, exit `4` | the smoke's own cancellation path works, and the credential reached a catalog that listed the model |
| 2 Nov 2026 | [41393924176](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41393924176) | `5b104189b85922d72713076529c82ab36622e1d7` | the `availability` one-request smoke: `PASS`, `LIVE_SMOKE_LATENCY_MS: 2294`, finish reason `stop`, 21 characters, `prompt=54 completion=10 total=64`, sentinel matched, clean artifact audit | the **current release's** adapter completes one bounded request on the real route, quickly |

The middle row's cause is not established here. What the record shows is that no response headers had
arrived when this build cancelled its own request at its own deadline: `http=(none)` is the absence of
a status line, `kind=cancelled` is the abort this process raised, and 89,059 ms against 90,000 ms is
the clock it was given. Provider queueing, a cold route, a shared-runner slowdown and Node's own
fetch behaviour are all consistent with that, and this repository has not measured any of them, so
none of them is named as the cause. What the third row rules out is one specific reading — that the
route cannot answer at all for this credential — and it does not rule out a slow answer under a
longer prompt, which is what the chain's requests are.

This procedure is for one controlled validation run against one fixture repository. It is not a
general tutorial; `README.md` is that, and where the two disagree the screens printed by
`node dist/bin.js <command> --help` are the ones that are true. A guard in
`tests/docs/real-model-procedure.test.ts` re-reads this file against those screens on every
`npm run check`, so a flag that stops existing here stops passing the build.

## 1. What only a human can supply

| Name | Read at | Required | If it is absent |
| --- | --- | --- | --- |
| `BHARATCODE_API_KEY` | `src/config/load-config.ts:135` | yes, for `plan`, `implement`, `review`, `repair` | `doctor` FAILs that row; `plan` exits 78 before asking anything (§4) |
| `BHARATCODE_MODEL` | `src/config/load-config.ts:152` | yes | `plan` has no `--model` flag, so the chain's fourth step ends in a configuration refusal |
| `BHARATCODE_API_BASE` | `src/config/load-config.ts:40` | no | defaults to `https://bharatcode.ai/api/model/v1` (`src/bharatcode/types.ts:9`) |
| `BHARATCODE_TIMEOUT_MS`, `BHARATCODE_MAX_RETRIES` | `src/config/load-config.ts:131-132` | no | `60000` ms and `3`; the live job sets `290000` and `0`. The Responses route answers as a stream, so headers arrive when the stream opens and this budget is enforced on every read for the whole answer. Before the headers arrive, Node's fetch still gives up at its own ~300 s `UND_ERR_HEADERS_TIMEOUT`, which no larger value here can raise |
| `BHARATCODE_RETRY_BASE_MS`, `BHARATCODE_RETRY_MAX_MS` | `src/config/load-config.ts:156-161` | no | 500 ms and 15 000 ms |
| `BHARATCODE_MAX_COMPLETION_REQUESTS`, `BHARATCODE_REQUEST_LEDGER` | `src/config/load-config.ts:79-121` | yes for the hosted live chain (`live-validation.yml:226` and `:233` set both); no for an ordinary run | unset, and the ceiling does not exist: no directory is made and no file is written. Set together they cap the number of completion **requests** one ledger can send — one marker file per request, created exclusively, so a resumed process and a racing process both see the same count, and a retried attempt pays in too. Set one without the other, or a limit below 1, or a relative ledger, and the load itself refuses at exit `78`. A slot is never refunded, so a fresh run needs a fresh directory, and a hosted re-run is refused rather than re-counted (§5) |
| `NO_COLOR` | `src/cli/render.ts:41` | no | colour stays on |

`implement --model <id>` can name a model for that one verb. Do not use it to pick a different
model from `BHARATCODE_MODEL`: the plan and the patch would then have been written by two
different models, and the evidence pack would not say so clearly enough to be worth reading.

**There is no other variable to set.** No environment variable opens remote publication; the
only publication switch is the `--publish` flag described in §2, and the chain in §4 does not use
it.

**One cheaper way to spend a key, and what it does not buy.** `npm run test:live`
(`package.json:55`) is the suite's own live mode: it sets an enable flag itself
(`MERGESUTRA_LIVE_BHARATCODE`, read at `tests/plan/live.test.ts:21`) and runs everything, which is what
turns the three tests that reach the real endpoint from skips into runs — `tests/plan/live.test.ts`,
`tests/implement/live.test.ts` (with that loop capped at 3 steps, `tests/implement/live.test.ts:96`),
and `tests/review/live.test.ts`. All three skip on a machine with no key, which is why every offline run
of this suite reports them as skipped rather than as passed. This is the shortest possible proof that the
adapter speaks to the gateway, and it is not §4's chain: it runs no gate, writes no patch, files no
evidence pack and renders no PR page, so a green live-mode suite does not close Stage 14.

### Putting the key into the environment

Type it into the shell at a prompt, so it never appears in a command line, a history entry, or a
script:

```sh
read -rs BHARATCODE_API_KEY
export BHARATCODE_API_KEY
export BHARATCODE_MODEL='<the model your account offers>'
```

- Never `export BHARATCODE_API_KEY=<the key>`: that writes the value into your shell history and
  into any file you paste it into.
- Never pass it as an argument. No flag accepts one, and the adapter's own refusal says so
  (`src/bharatcode/client.ts:536`).
- `unset BHARATCODE_API_KEY` when the run is over (§8).
- The key is chosen by your BharatCode account. This build cannot list model names: `doctor
  --connect` reports how many models the endpoint says it has, not what they are called, so a
  wrong `BHARATCODE_MODEL` surfaces as a refusal at `plan` rather than at `doctor`.

## 2. The only thing this run may touch

| Target | What the run does to it |
| --- | --- |
| `Pavithran-R-A/mergesutra`, issue #8 | reads it. Nothing here comments on it, closes it, or edits it. |
| public `main` branch of that repository | cloned anonymously at the head observed when validation starts; only the dedicated `fixtures/stage14-e2e/` task area and issue #8 are in scope |
| the fixture clone (called `<fixture-clone>` below) | reads it, then writes only inside a worktree the run creates for its own patch |
| `<mergesutra-checkout>/.mergesutra/` | writes the run record and the evidence pack |
| anything else | nothing. Not this repository's own files, not another repository on the account, not your shell configuration. |

The table above is a promise about intent, not an enforced sandbox. Since S14-9, ordinary
repository/workspace commands do **not** inherit environment-backed GitHub credentials:
`GH_TOKEN`, `GITHUB_TOKEN` and `GITHUB_PAT` are removed by the production runner, while the
dedicated MergeSutra-owned `gh api --method GET` transport keeps its authentication. The same
boundary removes the BharatCode key from child commands. This closes the direct environment-token
leak that the earlier procedure named.

It still does not turn a worktree into an OS sandbox. A repository program may use another
credential source available to the operating-system account (for example an independently
configured credential helper or keyring), or make unauthenticated network calls of its own. For
the controlled Stage 14 run, use an isolated account/session or a throwaway credential scoped to
`Pavithran-R-A/mergesutra` only. A run that cannot read is honest; a run that can
write more than the experiment intends is not.

The hosted harness snapshots the public `main` head at validation start, clones that branch anonymously,
and refuses if the advertised head moves while the clone is being made. The task itself is isolated to
`fixtures/stage14-e2e/`: `slugify` must trim separator characters from both ends, with five acceptance
criteria that each resolve to a command exit code. Issue #8 is the task; the criteria are the contract;
nothing about the run depends on anyone's opinion.

**The chain in §4 ends at a page; opening a draft request is a separate, human-approved act.**
`mergesutra pr <run-id> --approve <digest>` records a yes for exactly the page on screen and sends
nothing. `mergesutra pr <run-id> --publish`, run afterwards, is the second act: it re-decides the
digest, re-measures the patch, pushes the approved patch and opens a **draft** pull request through
the operator's own `gh` login. It never merges. The hosted harness never passes `--publish` and
deletes its scratch clone when it finishes, so a publication demonstration needs a persistent clone
and the manual chain below. A live run that stops before `--publish` is a complete evidence pack,
a rendered page and a digest — not a pull request.

## 3. Before the first command

```sh
cd <mergesutra-checkout>
npm ci
npm run build
node dist/bin.js --version
git -C <fixture-clone> rev-parse HEAD   # record this SHA; do not pull or move the clone during the run
git -C <fixture-clone> status --porcelain   # must print only what it printed before you started
```

Every command below is typed from `<mergesutra-checkout>`, in this order, and each one reads the
run record the previous one wrote. Use one shell, so the record's path assumptions hold.

**`<run-id>` is not one id for the whole chain.** `issue`, `inspect` and `contract` each file a *new*
record and print its path on their own `Run record:` line; from `plan` onward a stage writes into the
record it is handed and the id holds. So after each of the first three steps, read the id off that
line and use it for the next command. The ids that appear inside a screen's prose — "carried from run
…" — name *earlier* records; handing one of those to `plan` produces "has no Acceptance Contract",
which is a threading mistake and not a missing key (§7). From step 4 onward you may also omit the id
and let the command take the newest run, but naming it is better, because it makes a mistake visible
in your screen rather than in someone else's record.

Capture each step's own output as you go (`… | tee step-04.log`), and never redirect a dump of the
environment into a log (`env >`, `set >`, `printenv >>`): that is how a key gets into an artifact.

## 4. The chain

| # | Command | What it costs the model | Measured with no key | A live run should show |
| --- | --- | --- | --- | --- |
| 1 | `node dist/bin.js doctor --connect` | no completion; one read of `/models` | `1` | `0`, every row PASS |
| 2 | `node dist/bin.js issue <issue-url> --repo <fixture-clone>` | 0 | `0` | `0` |
| 3 | `node dist/bin.js inspect <fixture-clone>` | 0 | `0` | `0`, and a run id |
| 4 | `node dist/bin.js contract <run-id from step 3>` | 0 | `0` | `0`, both criterion families in one record |
| 5 | `node dist/bin.js plan <run-id from step 4>` | at most 2 | `78` | `0` |
| 6 | `node dist/bin.js implement <run-id> --repo <fixture-clone> --max-steps 8 --max-writes 4 --max-commands 3` | at most 8 | not walked — it needs the key | `3` (a model's claim is read, not saluted) or `4` |
| 7 | `node dist/bin.js verify <run-id> --repo <fixture-clone> --allow <gate-id>` | 0 | `1` | `0` if the gates pass, `1` if they do not |
| 8 | `node dist/bin.js review <run-id> --repo <fixture-clone> --max-review-cycles 1 --max-repair-cycles 1` | at most 2 | not walked | `3` |
| 9 | `node dist/bin.js status <run-id> --repo <fixture-clone>` | 0 | `0` | `0` |
| 10 | `node dist/bin.js report <run-id>` | 0 | `0` | `0` |
| 11 | `node dist/bin.js pr <run-id> --repo <fixture-clone>` | 0 | `4` | `3` with a page digest, or `4` |

Measured column: the credential-free walk recorded in `docs/SECURITY_GAP_REGISTER.md` under the
Stage 14 status block, re-taken on the tree at `5f31a8c` with `BHARATCODE_API_KEY`,
`BHARATCODE_MODEL`, `GH_TOKEN` and `GITHUB_TOKEN` all printed as UNSET before the first command. The
chain there is exactly this table's id threading: `doctor` 1, `issue` 0, `inspect` 0, `contract` 0,
`plan` 78, `verify` 1, `report` 0, `status` 0, bare `pr` 1, `pr <run-id from step 4>` 4, and a
read-only `resume` preview (no `--execute`) at 0. Step 2 read the real issue through the `gh` CLI;
step 11's `4` was `PR_PUBLICATION_BLOCKED` for want of a patch, which is the correct answer to a
request to publish nothing; the fixture's five tracked files hashed byte-identical before and after,
and its `git status --porcelain` still named only the file it named before. Steps 6 and 8 were not
walked, because both need the key this machine does not hold.

`contract` needs no flags here: every acceptance criterion is stated in the issue, and
`--criterion`/`--by`/`--check` exist for requirements that no file carries. Adding one for a
criterion the issue already states would attribute it to yourself rather than to the report.

`verify --allow <gate-id>` is consent, not configuration: the fixture's own gate (`npm test`) is
discovered from its `package.json`, and `verify` prints the gate id it is refusing to run without
you. There is no wildcard. Name the gate the screen shows you.

## 5. What the run can cost

The ceilings are code, not estimates:

| Verb | Completions | Where the bound lives |
| --- | --- | --- |
| `plan` | 1 ask + at most 1 schema repair | `src/plan/plan.ts:67`, `src/plan/plan.ts:239` |
| `implement` | 1 per turn, default 12, cap 40 | `src/implement/limits.ts:50`, `:69` |
| `review` | 1 ask + at most 1 schema repair, ≤3 rounds | `src/review/engine.ts:51`, `node dist/bin.js review --help` |
| `repair` | 1 per turn, default 6, ceiling 8, ≤3 cycles | `src/repair/limits.ts:34`, `:51` |
| every other verb | 0 | — |

One pass of §4, with the budgets that procedure types, therefore asks the model **at most 20
times** (2 + 8 + 2 + 6 + 2), and the shipped defaults would allow 26. The hosted live chain runs
only `plan`, `implement` and `review`, so its own ceiling is **12** (2 + 8 + 2), enforced by
`MAX_MODEL_COMPLETIONS` in `scripts/lib/live-qualification.mjs`; the other 8 belong to a repair
and re-review a person would run afterwards. `resume` may re-enter a stage, but it re-enters the
budget the record already holds and cannot raise a ceiling (`src/lifecycle/budget.ts`), so a
recovered run does not silently double the bill.

What this build bounds, and what it does not:

- **Output tokens.** Every request the chain makes carries a ceiling. `plan` and `implement` send
  `max_output_tokens: 4096` (`src/plan/plan.ts:245`, `src/implement/loop.ts:280`) and `review`
  sends 8192 (`REVIEW_MAX_OUTPUT_TOKENS` at `src/review/engine.ts:48`, sent at `:159`), which its
  one schema-repair turn carries too because both go through that call site. For the composition
  this workflow runs — 2 plan + 8 implement + 2 review, with review held to one cycle by
  `--max-review-cycles 1` at `scripts/e2e-validation.mjs:518` — that is at most **57,344** output
  tokens asked for in total. Widen the review cycles and the total moves with it: the shipped
  default is two cycles (`src/repair/bounds.ts:22`, ceiling 3 at `:27`), and the 12-request ceiling
  counts requests, not tokens, so the figure to budget money against is the worst product —
  12 requests at 8192, which is 98,304. The 200,000-character review receipt limit still stands
  behind all of it, in case a gateway ignores the ceiling it was sent
  (`MAX_REVIEW_ANSWER_CHARS` at `src/review/engine.ts:36`).
- **A cut-off answer.** `plan`, `implement` and `review` read the provider's own finish reason
  before interpreting any text, so a `response.incomplete` is filed as no plan, an
  `INCOMPLETE_OUTPUT` loop ending and a `REFUSED` review — never as a stored plan, a write, a
  command or a clean second reading — and none of them re-asks, so a truncation costs one request.
  One asymmetry a live run can hit: `plan` and `implement` send `reasoning: { effort: "none" }`
  (`src/plan/plan.ts:246`, `src/implement/loop.ts:281`) while `review` leaves reasoning at the
  provider's default, so a reviewer that reasons at length can be cut at 8192 and come back
  refused rather than answered. That is the ceiling doing its job; raise
  `REVIEW_MAX_OUTPUT_TOKENS`, or send `enableThinking: false` from the review engine, before a
  live run if a second reading every time matters more than the bound.
- **Money.** The cost in your currency is the provider's price for the usage the record reports,
  which this repository cannot see. Set the ceiling before the run, in requests or in your own
  billing terms. The dispatched workflow's hard stops are 12 completions, 25 minutes of chain
  wall clock, 290 s per request and zero retries.

Recommended hard stop: end the run at 20 completions or 10 minutes of wall clock, whichever comes
first. The loop also stops itself at 8 minutes per `implement` entry
(`src/implement/limits.ts:61`).

After the run, the record — not this file — holds what was actually spent: `plan` stores the model
name the gateway answered with and the usage it reported (`src/plan/plan.ts:181-182`), and the
implementation loop counts its requests (`src/implement/state.ts:134`). A gateway's own claim about
which model served a request is provenance, not authority (S12-27).

### Which of these stops a request, and which only reads a number afterwards

The list above mixes two kinds of bound, and the difference is the whole point of the request
budget: one kind can prevent a spend, the other can only report one.

Enforced **before** a request leaves the process — a refusal here means no bytes went to the provider:

| Bound | Where the refusal happens | What it refuses |
| --- | --- | --- |
| the 12-request ceiling | `src/bharatcode/client.ts:533`, one exclusive marker per request in the ledger directory | any completion past the ceiling, with `REQUEST_BUDGET_EXHAUSTED` |
| an unusable ledger | the same call, and `scripts/e2e-validation.mjs:63` before the chain's first child | `REQUEST_BUDGET_UNAVAILABLE` when a marker cannot be created, and a driver refusal for a symlink, a non-directory, an uncreatable, a non-private or a non-exclusive-create ledger |
| the ceiling pair itself | `scripts/e2e-validation.mjs:59` | a live chain that pinned no ceiling, pinned a number other than 12, named a relative ledger, or left retries on |
| a workflow re-run | `.github/workflows/live-validation.yml:111`, ahead of the catalog read at `:177` | `GITHUB_RUN_ATTEMPT` other than `1`, at exit `78`, before any credentialed call |
| zero retries | `BHARATCODE_MAX_RETRIES: '0'` on the live job | the extra POSTs one `complete()` would otherwise make |

Decided **after** the spend, as qualification — each of these can fail a finished run and cannot
stop a request:

| Check | Where it lives | What it measures |
| --- | --- | --- |
| completions at or under 12 | `scripts/lib/live-qualification.mjs:179` (`MAX_MODEL_COMPLETIONS` at `:20`) | what the stages filed as they ran |
| the ledger's own count | `scripts/e2e-validation.mjs:761`, read by `countReservations()` at `:241` | the marker files the guard actually wrote, independent of any stage's self-report |
| the 25-minute chain clock and the 290 s per-request deadline | the driver's wall clock and `BHARATCODE_TIMEOUT_MS` | elapsed time; a deadline that fires has already paid for its request |
| verify, `COMPLETED_BY_MODEL`, fixture acceptance, review findings, no unapproved repair plan | the conjunction in §8 | whether the run achieved the task, not whether it stayed in budget |

The ledger count is deliberately a *second* reading rather than the enforcement: the guard is the
only thing that can say "not this request", and the readback is how the report can say "the guard
was not bypassed" without taking the stages' word for it. A refusal from the guard never refunds its
slot — a cancelled, killed or failed request was still asked for — which is why a fresh run needs a
fresh ledger and why the workflow refuses a re-run instead of trusting the new runner's empty
temporary directory. Where the pre-request guard and the qualification rule disagree, the run is
refused: more markers than the ceiling means the guard was bypassed rather than exceeded, and an
unreadable ledger means the chain cannot say what it allowed. When the loop ends on a budget
refusal it files `MODEL_UNAVAILABLE` with a detail beginning `No request was sent.`
(`src/implement/loop.ts:299`), because every other word in that record field describes a request
that left.

### The one-request smoke, which asks cheaper questions first

`.github/workflows/live-smoke.yml` is not this chain. It answers one question — can this
credential reach this route, and does the provider mark the answer complete — for one completion
and nothing else, so it is the instrument for checking a route before committing to the
12-completion, 25-minute run above. Its budgets are the two frozen blocks in
`scripts/lib/live-smoke-rules.mjs`: `SMOKE_BUDGET` (`:12`) and `SMOKE_BUDGET_AVAILABILITY`
(`:47`), both the model `qwen-3.8-27b`, one completion (`:20`), `max_output_tokens: 512` (`:23`),
`temperature: 0`, reasoning off, streaming on, `store` off, and zero retries (`:31`). They differ
in one number: the clock on the credentialed phase, 90 seconds for `standard` (`:30`) and 270
seconds for `availability` (`:49`). A dispatch chooses a variant by name from the frozen
`SMOKE_VARIANTS` map (`:56`) and cannot choose a number; an unknown name is refused at exit `78`
before a client exists. `scripts/live-smoke.mjs` takes the model from the standard block (`:37`),
which is the model both variants share, refusing at exit `78` if a `BHARATCODE_MODEL` asks for a
different one — so a run cannot choose its own target either. What the smoke does not set, it does
not claim either:
`stream` and `store` are the adapter's own hard-coded fields (`src/bharatcode/client.ts:1008-1009`),
and the policy suite reads that file too, so the artifact's description of the request is checked
against the code that builds it rather than restated by it.

A `PASS` is that connectivity verdict and nothing else: a terminal `response.completed` with
non-empty text behind it. It does not assert that the text was the sentinel — the match is
recorded separately as `answer.matchedSentinel` in the artifact and
`LIVE_SMOKE_SENTINEL_MATCHED` on the log, so a route that answers in other words still passes
and is never described as having echoed the prompt.

What it refuses, and with which exit code: a missing key is the product's own configuration
refusal (`scripts/live-smoke.mjs:177`, exit `78`); a model the authenticated catalog does not list
(`:246`) is refused at exit `79`, before any completion is asked; a stream that never reached
`response.completed` is `INCOMPLETE` at exit `3`; its partial text never decides the verdict — it
is read only as a length and a redacted, one-line preview of at most 200 characters
(`scripts/lib/live-smoke-rules.mjs:215-217`) — because a cut stream and an answered one cannot be
told apart by their text; and an artifact that still carries the credential's bytes is deleted rather
than uploaded (`scripts/live-smoke.mjs:152`). Every string the provider chooses — its finish reason,
its model name, its answer text, the wording of a transport failure — is redacted and forced onto
one line before it is written or printed (`scripts/lib/live-smoke-rules.mjs:188`), so an answer
cannot forge a second `LIVE_SMOKE:` verdict line in a log a reader trusts. It has been dispatched
twice, and the two readings are recorded apart because they answer different questions. Run
[39909412225](https://github.com/Pavithran-R-A/mergesutra/actions/runs/39909412225) on 2026-10-23
(`cd03393c`) ran the `standard` budget: the authenticated catalog listed two models and contained the
requested one, then the completion failed at 89,059 ms against the 90,000 ms clock as
`kind=cancelled http=(none)`, with no token usage reported, exit `4`, and a clean artifact audit. No
response headers had arrived when this build cancelled its own request; that is the whole of what that
row says about the failure, and its cause — provider queueing, a cold route, runner contention, Node's
fetch behaviour — is not established by anything in this repository, so none of them is named here.
Run [41393924176](https://github.com/Pavithran-R-A/mergesutra/actions/runs/41393924176) on 2026-11-02
(`5b104189`) ran the `availability` budget against the same route and printed `LIVE_SMOKE: PASS`,
`LIVE_SMOKE_LATENCY_MS: 2294`, `LIVE_SMOKE_FINISH_REASON: stop`, `LIVE_SMOKE_CHARS: 21`,
`LIVE_SMOKE_TOKENS: prompt=54 completion=10 total=64`, `LIVE_SMOKE_SENTINEL_MATCHED: yes` and
`LIVE_SMOKE_ARTIFACT_AUDIT: clean`, at job attempt 1. Each row is one host's reading of one dispatch.
Together they show that this credential reaches a catalog that lists the model and that the current
release's adapter completes one bounded request on that route; neither row says anything about a
chain, whose requests are longer, or about latency under the chain's 290-second per-request clock —
which no smoke measures, because the smoke runs its own frozen deadline. The `availability` variant
exists because of the first row, not as a fix for it. Its switch defaults to off, and a run
needs the operator's yes for that specific SHA.

## 6. The two approvals, and what they do not do

`repair` and `pr` are the two commands that need a typed yes, and both take a 64-hex digest:

```sh
node dist/bin.js repair <run-id> --repo <fixture-clone> --approve-plan <64-hex plan digest>
node dist/bin.js pr <run-id> --repo <fixture-clone> --approve <64-hex publication digest>
```

Read the document the digest names before typing it. `repair` is the only command that edits, and
it edits against the frozen plan you approved — a digest copied from another run, or from a patch
that has since moved, will not match, and the command will say so instead of working. `pr`'s
approval records that a human said yes to that page; it does not itself publish. The remote act is
a second invocation, `node dist/bin.js pr <run-id> --repo <fixture-clone> --publish`, which asks
GitHub through your own `gh` login to push the approved patch and open a **draft** pull request. It
re-decides the digest, re-measures the workspace before sending, and records the draft's URL and
number on the run; it never merges. If it fails after the request was accepted, exit `4` carries the
transport's own remediation: inspect the remote, and do not assume a retry is safe. Both are
lowering-only knobs elsewhere:
`--max-*-cycles` may reduce a budget and may not raise one above the printed ceiling.

## 7. If a step fails

- Exit `1` naming a missing family — "has no Acceptance Contract", or an earlier stage's record being
  described back at you: a threading mistake, not a product failure. You handed that stage a record
  from before the family was filed (§3). `status` prints what the record you named actually holds;
  re-type the command with the id the previous step's `Run record:` line printed. Nothing has been
  spent, and no run needs to be started again.
- Exit `78`: configuration. Check `BHARATCODE_MODEL` first — it is the one name §1 says has no
  flag — then `doctor --connect`. No budget has been spent yet.
- Exit `4` (`*_BLOCKED`): a required input could not be obtained. Read the screen; it names the
  missing thing. `status`, then `resume` with no flags to see the plan, then `resume --execute` to
  run the one stage it names.
- Exit `3` (`*_INCONCLUSIVE`, `REVIEW_RECORDED`, `PR_APPROVED_LOCAL`): the stage completed and left
  a decision to a person. This is a normal end state for steps 6, 8 and 11, not a failure.
- Interrupted mid-loop (terminal closed, Ctrl-C, power loss): do not touch the workspace. Run
  `node dist/bin.js status <run-id> --repo <fixture-clone>` and follow the next safe action it
  prints. The run's lock is reported there, so a second command will refuse rather than interleave.
- A refusal naming `EXECUTION_CONSENT` or a gate id: that is §4 step 7's consent, and it is
  deliberate. Add `--allow <the gate id named>`, nothing broader.
- A credential appearing in any artifact: treat it as exposed. Stop the run, do not commit the
  artifact, rotate the key at the provider. Then check the screens against the shapes below, and
  record the finding in `docs/SECURITY_GAP_REGISTER.md` as a new gap rather than as a footnote.

Never "tidy" a failed run with `git reset --hard`, `git clean`, `git stash` or a delete. The
evidence is the bytes as found, and a recovery that destroys them also destroys the reason the
run was worth doing.

## 8. After the run

```sh
node dist/bin.js --json report <run-id> > /dev/null   # the pack is on disk; this only proves it parses
grep -REno 'bc_live_[A-Za-z0-9_-]{8,}' .mergesutra | wc -l   # expect 0
grep -REno 'bc_live_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{12,}' .mergesutra | wc -l   # expect 0
grep -REno 'gh[pousr]_[A-Za-z0-9]{12,}' .mergesutra | wc -l   # expect 0
git status --short   # expect only what it showed in §3
unset BHARATCODE_API_KEY
```

Screen the artifacts by shape, never by the key's value: `grep -F "$BHARATCODE_API_KEY" …` puts
the credential in a command argument, which is the thing §1 forbids. The three patterns above are
credential families this build's release boundary refuses to pack
(`tests/security/credential-boundary.test.ts`).

Then, and only then, clean the fixture: `git -C <fixture-clone> worktree list` names the worktree
the run made; remove it by path with `git -C <fixture-clone> worktree remove <path>`. Leave
`.mergesutra/runs/<run-id>.json` and `.mergesutra/runs/<run-id>/` in place — they are the evidence
— and leave the fixture's issue open until the human decision about the pull request is made.

### What the harness decides, and on which facts

`scripts/e2e-validation.mjs live` does not grade the run on workflow status. It calls one conjunction,
`liveQualificationFailures(…)` in `scripts/lib/live-qualification.mjs`, which returns every item below
that is not true rather than only the first, and the run is refused when that list is non-empty:

1. the completions the chain observed stay at or under 12 (`MAX_MODEL_COMPLETIONS`);
2. the chain stays inside its 25-minute wall clock;
3. `mergesutra verify` exits 0;
4. the implementation record says `COMPLETED_BY_MODEL` — the loop finished the task it was asked to do;
5. the independent fixture facts all hold: `directBehaviorsPass` (a hard-coded three-assertion script
   run against the workspace's `slugify.js`), `checkedScriptPass` (the check file run as its own
   process), `checkContainsAllThreeAssertions`, `dependencyFree`, and both required files present in
   the changed-path list;
6. the review completed with zero findings;
7. no repair plan is waiting unapproved.

Two more refusals come from the driver itself rather than from that function, because they are facts
about the ledger and the function is handed the stages' records: a ledger it cannot read, and more
reservation markers in the ledger than the ceiling (`scripts/e2e-validation.mjs:755` and `:761`). Both
are raised after the run, and both refuse the certificate rather than a request — the spend, if any,
had already happened by then. The count is taken from the marker files the guard wrote
(`countReservations()` at `scripts/e2e-validation.mjs:241`) and appears in the summary artifact as
`budget.reservationsWrittenToLedger`, beside `budget.ceilingEnforcedBeforeTransport`, so a reader can
compare the guard's own record against what each stage claimed without trusting either. No message
the driver files and no field the summary carries contains the ledger path: the summary and
`live-failure.json` are uploaded as artifacts, and a hosted path is innocent while a local operator's
is not something to publish.

Criterion 5's `checkContainsAllThreeAssertions` is the one that changed for issue #8's fourth criterion,
which asks that the check file *contain assertions* for the three required behaviors. It used to ask
whether each `slugify('<input>')` string appeared anywhere in the file — a file authored by the model
being graded — so a comment quoting the issue satisfied it. It now reads the file: comments are dropped,
string literals are kept whole, and an input counts only inside the arguments of an `assert` call. A
model that writes `// also cover slugify("--x--")` and nothing else is refused, which is what a
runbook promise about independent acceptance requires.

That item's message is deliberately coarse — one line covers five causes — and the driver stops at the
first failing item it prints, so the screen is a partial reading. The summary artifact carries the detail
beside it: `fixtureAcceptance.missingAssertionInputs` lists the required inputs the
check file did not assert, and `fixtureAcceptance.changedPaths` the paths the run changed. A refused run
is read from those fields before anyone guesses at the cause. Exports written before this commit carry
the booleans but not that list.

The rules are a module, so they are testable without paying for a chain: `npm run test` runs
`tests/security/live-qualification-rules.test.ts`, which plants workspaces (including a
comment-only check file, an unfixed `slugify.js`, a fixture that added a dependency, and a change
outside the allowed paths) and executes the shipped module in a real Node process. Those tests are the
reason a future edit to a threshold cannot quietly redefine what "qualified" meant.

## 9. What the operator reports back

Report the run, including the parts that did not work. Nothing in this list may be summarised
away, and no line of it may contain a credential:

1. the commit the build came from, and `node dist/bin.js --version`;
2. the run id, and the model name the gateway reported;
3. each command from §4 with its exit code captured beside it, and its output file;
4. the number of completions the record reports, and the usage the gateway reported, with the
   caveat in §5 that a gateway's numbers are its own claim;
5. which of the issue's five criteria the evidence pack shows as proved, and which it does not;
6. every refusal, in full, with the screen text that printed it;
7. the two digests that were approved, and what was read before approving each;
8. the output of §8's checks, and `git status --short` in both repositories.

A real-model result closes Stage 14 only when the acceptance criteria, independent fixture
checks, security conditions, implementation completion, and review evidence are all satisfied.
Merely obtaining a successful workflow status or a recorded review does not close this stage.

## 10. What this procedure does not prove

- The real-model run has occurred, but does not prove that the entire task was solved.
  GitHub Actions run `37655552898` at `e0ef898b12db5d38025ce904d0cc1e2493a9a0d6`
  completed its Windows and Ubuntu no-key jobs and its credentialed Qwen job. The sanitized
  live artifact records `IMPLEMENTATION_INCONCLUSIVE` (schema refusal after a write),
  `VERIFICATION_PASS` for the repository-declared gates, and a HIGH requirement gap in review:
  `fixtures/stage14-e2e/check.mjs` did not acquire the issue's required assertions.
  The five issue-level criteria remained `MANUAL_REVIEW_REQUIRED`; publication was blocked.
  The fixture's primary tracked bytes/status were unchanged, and the scan found no
  credential-shaped leaks. This was useful safety evidence, not a completed contribution — and the job
  that produced it still concluded `success`, because the fail-closed
  `implementation?.status !== 'COMPLETED_BY_MODEL'` rule — item 4 of §8's conjunction — did not exist in
  `scripts/e2e-validation.mjs` at that commit; `git log -S COMPLETED_BY_MODEL` puts it in at `759c1b9`.
- Six of the twelve paid attempts that reached the implementation loop ended early for the same product
  reason, and that reason is now fixed but not yet re-measured. Enumerating the `live-model-*` artifacts
  gives 23 rows over 22 distinct run ids (one run uploaded twice), so 22 attempts; 9 stopped at `plan`
  and 1 at the `implement` precondition, so 12 ran the loop — 6
  ended `SCHEMA_REFUSAL`, 5 `MAX_STEPS`, 1 `DEADLINE` (S14-10 names all 12). The six in the first class
  end with the identical detail, `No usable action after 2 rejected answer(s). Last problem: Rejected
  model action: content: Required` — while every one of them had a usable action between the two
  rejected answers. `37648533534`, `37655552898`, `37923726827` and `37926378657` each stopped at 5 of 8
  turns with one write and never attempted `fixtures/stage14-e2e/check.mjs`; `37943570834` stopped at
  4 of 8 having written `slugify.js` twice; run `37950266934` at
  `66cd695e0cbe7286058411dac2ad6868bda98dd7` stopped at 4 of 8 with **both** required files on disk and
  every independent fixture fact true. None of the six came near the ceiling in §5: 7, 6 and 6
  completions on the three artifacts that carry usage, against 12. No model declined the task.
  `src/implement/loop.ts` compared a run-wide tally of
  rejected answers to `maxSchemaRepairs`, so the second malformed answer in a run ended it even when an
  applied write had landed in between (S14-10).
  The bound is now a streak that a usable answer resets, and the record carries both numbers.
  The `MAX_STEPS` and `DEADLINE` classes are **not** addressed by this fix; they are what the
  required-only plan and finish guidance at `4a27c5f` targets, and no reading here proves either.
  What a rerun should therefore show, and what this document does **not** claim until it does: the
  chain reaching `FINISH` with `implementation.status === 'COMPLETED_BY_MODEL'`, and a
  `Rejected answers` screen row if the model still sends answers nothing could run from. A rerun is a
  chargeable action and needs the operator's explicit authorization.
- The pre-request ceiling has never met the real provider. Every claim in §5's first table is proven
  offline — against a fake transport and a real filesystem, in `tests/bharatcode/request-budget.test.ts`
  (21 cases), `tests/security/live-budget-preflight.test.ts` (21 cases, which runs the shipped module in
  a real Node process against planted directories) and the workflow-policy suite — and the hosted
  live-model job has not been dispatched since the pair was installed, because dispatching it spends.
  Nothing here therefore claims that a live chain has ever been stopped by the guard; it claims that a
  request past the ceiling is refused before the adapter builds one, and that the workflow refuses a
  re-run before its first authenticated read.
- The credential-free chain has hosted readings on both Ubuntu and Windows, including
  post-merge checks. The ordinary CI matrix also runs Ubuntu/Windows × Node 22/24.
  Neither the matrix nor a no-key walk proves an actual model patch is acceptable.
- It does not make a run's blast radius provably the fixture. Since S14-9, ordinary
  repository/workspace child processes receive neither the BharatCode credential nor
  `GH_TOKEN`/`GITHUB_TOKEN`/`GITHUB_PAT`; GitHub authentication is preserved only for
  MergeSutra-owned read operations. That closes the direct ambient-environment leak, but it is still
  not an OS sandbox: repository code can use some other credential source available to the account
  or make its own network calls. That is why §2 still requires an isolated session or credential
  scoped to the fixture.
- Hosted CI is no longer blocked by the private-repository minutes limit: after the canonical
  repository became public, the full Ubuntu/Windows × Node 22/24 release matrix resumed and is
  green. The live-model job remains intentionally separate from ordinary CI so untrusted pull
  requests never receive a BharatCode credential and routine checks never spend provider capacity.
- `tests/docs/real-model-procedure.test.ts` checks that the commands and variables named here
  exist and that the budgets typed here are accepted. It cannot check whether a correctly spelled
  command is a safe instruction, it cannot see whether the exit codes above were measured or
  copied forward, and it has no idea which run id each step should be handed — the threading rule in
  §3 was found by executing the chain against the real fixture and watching step 5 refuse, not by a
  test. That is why §1 exists, and why §9 belongs to a person.
