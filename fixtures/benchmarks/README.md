# Benchmark fixtures (offline preparation)

These fixtures make the ten classes in [`docs/REAL_TASK_BENCHMARK.md`](../../docs/REAL_TASK_BENCHMARK.md)
executable. They do **not** make the benchmark run: no model has been called here, and every
row in that document stays `OPEN` until a real, pinned run records its own evidence.

## Layout

```
fixtures/benchmarks/
  repos/<id>/            the model-visible repository: issue, source, original tests
  private/<id>/          never copied into the model's worktree
    case.json            {id, title, baseline, reference[], wrong[]}
    oracle.mjs           independent checker: node oracle.mjs <candidate-root> <base-root>
    reference/...        a complete fix, copied over a fresh base
    wrong/...            a plausible incomplete fix, copied the same way
```

`repos/` has no oracle, `case.json`, `reference/` or `wrong/` inside it, so a model working
the issue cannot read the acceptance criteria. `tests/benchmark/oracles.test.ts` asserts that
separation on every run.

## The control protocol

[`scripts/benchmark-oracles.mjs`](../../scripts/benchmark-oracles.mjs) copies each fixture
three times into a scratch directory outside the checkout and requires:

| copy | baseline suite | independent oracle |
| --- | --- | --- |
| base | pass | **fail** |
| reference | pass | **pass** |
| wrong | pass | **fail** |

Six expectations per case, ten cases, no network and no model. A case passes only when all six
hold, so the oracle is proven able to separate a complete fix from the base defect and from a
fix that repairs the visible symptom but leaves one contract clause unmet.

Run one case while editing a fixture:

```
node scripts/benchmark-oracles.mjs B06
```

Not one of these copies is the benchmark. A real row additionally needs a pinned source SHA,
a pinned fixture base SHA, the model's own request/usage record, the reviewer findings and the
outcome appended to the ledger in `docs/REAL_TASK_BENCHMARK.md`.

## What each case is designed to catch

| Case | Fixture defect | The `wrong` copy leaves |
| --- | --- | --- |
| B01 | trim/lowercase only | whitespace and separator runs unchanged |
| B02 | port parsing accepts malformed values | unvalidated range and error contract |
| B03 | help on stderr, unknown option becomes a value | help fixed, argument validation still absent |
| B04 | timer not cleared, arguments unchecked | timer cleared on success only |
| B05 | naive join/split encoding | escaped values only, no key sorting |
| B06 | `path.resolve` alone admits `..` and symlinks | realpath check missing |
| B07 | file and ambient env override explicit settings | precedence fixed, URL check and leak still present |
| B08 | two call sites, bounds unchecked | one file fixed, `format.js` still bounds-blind |
| B09 | green suite never exercises numeric order | the new test does not catch the defect |
| B10 | slice-based truncation splits surrogate pairs | code-point loop without the too-small suffix check |

B09 is the coverage case: its oracle also proves the reference's added tests fail on the base,
so a candidate cannot satisfy it by editing the implementation alone. B10 is the repair case:
the fixture prepares the rejection a reviewer should make, and the ledger row only fills in
after a real digest-bound approval and rerun.

## Platform note

B03's class requires both Node 22 and 24. The fixtures were authored and controlled on the
local Node 24 runtime; the Node 22 leg is part of the real run, not of these offline controls.
B06 creates directory junctions on Windows and symlinks elsewhere, so it is the one case whose
scratch setup depends on host privileges; the runner reports a failed case rather than skipping.
