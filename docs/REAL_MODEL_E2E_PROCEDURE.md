# Real-model end-to-end procedure

**Read this first: no run described here has happened.** Stage 14 stops at a credential this
repository does not hold, and the handover is this file. The "measured" column in §4 records
what every step did on the committed tree with no key in the environment; the "a live run should
show" column is a prediction written from source, not a result. When the run happens, the person
who ran it replaces those predictions with captured output — see §9.

This procedure is for one controlled validation run against one fixture repository. It is not a
general tutorial; `README.md` is that, and where the two disagree the screens printed by
`node dist/bin.js <command> --help` are the ones that are true. A guard in
`tests/docs/real-model-procedure.test.ts` re-reads this file against those screens on every
`npm run check`, so a flag that stops existing here stops passing the build.

## 1. What only a human can supply

| Name | Read at | Required | If it is absent |
| --- | --- | --- | --- |
| `BHARATCODE_API_KEY` | `src/config/load-config.ts:74` | yes, for `plan`, `implement`, `review`, `repair` | `doctor` FAILs that row; `plan` exits 78 before asking anything (§4) |
| `BHARATCODE_MODEL` | `src/config/load-config.ts:91` | yes | `plan` has no `--model` flag, so the chain's fourth step ends in a configuration refusal |
| `BHARATCODE_API_BASE` | `src/config/load-config.ts:38` | no | defaults to `https://bharatcode.ai/api/model/v1` (`src/bharatcode/types.ts:9`) |
| `BHARATCODE_TIMEOUT_MS`, `BHARATCODE_MAX_RETRIES` | `src/config/load-config.ts:70-71` | no | the code's own defaults |
| `BHARATCODE_RETRY_BASE_MS`, `BHARATCODE_RETRY_MAX_MS` | `src/config/load-config.ts:95-100` | no | 500 ms and 15 000 ms |
| `NO_COLOR` | `src/cli/render.ts:41` | no | colour stays on |

`implement --model <id>` can name a model for that one verb. Do not use it to pick a different
model from `BHARATCODE_MODEL`: the plan and the patch would then have been written by two
different models, and the evidence pack would not say so clearly enough to be worth reading.

**There is no other variable to set.** Nothing in this build reads a switch that opens remote
publication; that sentence was false in this repository's own manual until S14-6 removed it.

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
  (`src/bharatcode/client.ts:525`).
- `unset BHARATCODE_API_KEY` when the run is over (§8).
- The key is chosen by your BharatCode account. This build cannot list model names: `doctor
  --connect` reports how many models the endpoint says it has, not what they are called, so a
  wrong `BHARATCODE_MODEL` surfaces as a refusal at `plan` rather than at `doctor`.

## 2. The only thing this run may touch

| Target | What the run does to it |
| --- | --- |
| `Pavithran-R-A/mergesutra-e2e-fixture`, issue #1 | reads it. Nothing here comments on it, closes it, or edits it. |
| the fixture clone (called `<fixture-clone>` below) | reads it, then writes only inside a worktree the run creates for its own patch |
| `<mergesutra-checkout>/.mergesutra/` | writes the run record and the evidence pack |
| anything else | nothing. Not this repository's own files, not another repository on the account, not your shell configuration. |

The table above is a promise about intent, not an enforced sandbox. A command this run permits can
start a process that inherits whatever GitHub login the shell already has, because `gh` is this
build's read transport (§10). So bring a **throwaway credential scoped to the fixture repository
alone** — a fine-grained token that can see `Pavithran-R-A/mergesutra-e2e-fixture` and nothing else
— rather than running the validation signed in as an account that can write everything you own. If
that is not available to you, run the chain with no GitHub login at all and expect `issue` to fail
before any budget is spent; a run that cannot read is honest, and a run that can write too much is
not.

The fixture clone is pinned at `6f3a0adb17389b93fd76b95c21a1c9eb7b161998` on `main`, and its issue
asks for one deterministic change: `slugify` must trim separator characters from both ends, with
five acceptance criteria that each resolve to a command exit code. Issue #1 is the task; the
criteria are the contract; nothing about the run depends on anyone's opinion.

**The end of this chain is a page, not a pull request.** `src/pr/publisher.ts:98`
(`unavailableRemote()`) is the publication transport this build ships, and both of its methods —
push a branch, open a request — refuse whatever was approved before them. No flag, environment
value or digest reaches a remote. A successful live run therefore ends with a complete evidence
pack and a rendered PR page, and the pull request itself is opened by hand, by a person, in the
fixture repository, outside this tool.

## 3. Before the first command

```sh
cd <mergesutra-checkout>
npm ci
npm run build
node dist/bin.js --version
git -C <fixture-clone> rev-parse HEAD   # must print 6f3a0adb17389b93fd76b95c21a1c9eb7b161998
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
| `review` | 1 ask + at most 1 schema repair, ≤3 rounds | `src/review/engine.ts:40`, `node dist/bin.js review --help` |
| `repair` | 1 per turn, default 6, ceiling 8, ≤3 cycles | `src/repair/limits.ts:34`, `:51` |
| every other verb | 0 | — |

One pass of §4, with the budgets that procedure types, therefore asks the model **at most 20
times** (2 + 8 + 2 + 6 + 2), and the shipped defaults would allow 26. `resume` may re-enter a
stage, but it re-enters the budget the record already holds and cannot raise a ceiling
(`src/lifecycle/budget.ts`), so a recovered run does not silently double the bill.

Two things this build cannot bound, stated because the ceiling above is otherwise misleading:

- **Tokens.** No call site sets `max_tokens` (`src/bharatcode/types.ts:55` declares it and nothing
  passes it), so per-answer length is the gateway's default. What MergeSutra does bound is what a
  single answer may be before it is refused as too large: 96 KB for an implementation turn
  (`src/implement/limits.ts:58`), 64 KB for a repair turn (`src/repair/limits.ts:42`).
- **Money.** The cost in your currency is that many requests at your provider's price, which this
  repository cannot see. Set the ceiling before the run, in requests or in your own billing terms,
  and treat 20 requests as the plan.

Recommended hard stop: end the run at 20 completions or 10 minutes of wall clock, whichever comes
first. The loop also stops itself at 8 minutes per `implement` entry
(`src/implement/limits.ts:61`).

After the run, the record — not this file — holds what was actually spent: `plan` stores the model
name the gateway answered with and the usage it reported (`src/plan/plan.ts:181-182`), and the
implementation loop counts its requests (`src/implement/state.ts:134`). A gateway's own claim about
which model served a request is provenance, not authority (S12-27).

## 6. The two approvals, and what they do not do

`repair` and `pr` are the two commands that need a typed yes, and both take a 64-hex digest:

```sh
node dist/bin.js repair <run-id> --repo <fixture-clone> --approve-plan <64-hex plan digest>
node dist/bin.js pr <run-id> --repo <fixture-clone> --approve <64-hex publication digest>
```

Read the document the digest names before typing it. `repair` is the only command that edits, and
it edits against the frozen plan you approved — a digest copied from another run, or from a patch
that has since moved, will not match, and the command will say so instead of working. `pr`'s
approval records that a human said yes to that page; it does not publish, because §2's transport
refuses. Both are lowering-only knobs elsewhere: `--max-*-cycles` may reduce a budget and may not
raise one above the printed ceiling.

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
grep -REno 'sk-[A-Za-z0-9_-]{12,}' .mergesutra | wc -l   # expect 0
grep -REno 'gh[pousr]_[A-Za-z0-9]{12,}' .mergesutra | wc -l   # expect 0
git status --short   # expect only what it showed in §3
unset BHARATCODE_API_KEY
```

Screen the artifacts by shape, never by the key's value: `grep -F "$BHARATCODE_API_KEY" …` puts
the credential in a command argument, which is the thing §1 forbids. The two patterns above are
the families this build's release boundary already refuses to pack
(`tests/security/credential-boundary.test.ts`).

Then, and only then, clean the fixture: `git -C <fixture-clone> worktree list` names the worktree
the run made; remove it by path with `git -C <fixture-clone> worktree remove <path>`. Leave
`.mergesutra/runs/<run-id>.json` and `.mergesutra/runs/<run-id>/` in place — they are the evidence
— and leave the fixture's issue open until the human decision about the pull request is made.

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

That report is what closes Stage 14 and starts Stage 15. Until it exists, every claim in this file
about what a live run "should show" remains a prediction.

## 10. What this procedure does not prove

- It is not a real-model result. The run it describes has not happened, and nothing here may be
  presented as one.
- Its measured column is one host: Windows 10 with Git Bash. The gates have a second reading now —
  the full quality sequence ran green on Linux (WSL2) at the same commit, recorded as S14-8 in
  `docs/SECURITY_GAP_REGISTER.md` — but §4's chain does not, and the reason is a dependency this file
  states only here: `gh`, which is how `issue` reads an issue URL (`src/core/runner.ts:55`), is not
  installed on that Linux host, so step 2 cannot run there and nothing downstream of it can be
  threaded. A second reading of this chain needs a Linux host with an authenticated `gh`, or a second
  Windows machine.
- It does not make a run's blast radius provably the fixture. A process a permitted command starts
  still inherits the ambient `gh` login, because `gh` is this build's read transport
  (`src/core/runner.ts:55`, and S14-4's limitation 3). That is why §2 tells whoever runs this to
  bring a throwaway credential scoped to the fixture repository alone, instead of a login that can
  write anything they own.
- It does not verify the hosted CI reading of the same suite, which an account billing limit is
  currently preventing; the failure signature is recorded in the register.
- `tests/docs/real-model-procedure.test.ts` checks that the commands and variables named here
  exist and that the budgets typed here are accepted. It cannot check whether a correctly spelled
  command is a safe instruction, it cannot see whether the exit codes above were measured or
  copied forward, and it has no idea which run id each step should be handed — the threading rule in
  §3 was found by executing the chain against the real fixture and watching step 5 refuse, not by a
  test. That is why §1 exists, and why §9 belongs to a person.
