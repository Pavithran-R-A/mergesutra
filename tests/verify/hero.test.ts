import { afterEach, describe, expect, it } from 'vitest';
import { createRunner, defaultRunner } from '../../src/core/runner.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runPlanStage } from '../../src/plan/plan.js';
import { runImplementStage } from '../../src/implement/implement.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import { formatVerification } from '../../src/cli/verify.js';
import { createRenderer } from '../../src/cli/render.js';
import { writeAction, checkAction, finishAction, digestOf } from '../helpers/implement.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { hasGit, initRepository } from '../helpers/git.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { put } from '../helpers/verifyRun.js';
import { memoryRunStore } from '../helpers/github.js';
import type { InjectedCriterion } from '../../src/contract/derive.js';

/**
 * The one run in this repository that does all seven stages for real.
 *
 * Everything else in Stage 7's suite asks a narrow question of a narrow module.
 * This file asks the only question a reviewer actually has — *can I follow a
 * requirement of this issue to the command that proved it?* — and answers it with
 * nothing faked except the model, which is a scripted stand-in because a
 * credential is not part of Stage 7 (§32) and a model's mood is not evidence.
 *
 * The scenario is deliberately tiny so that every moving part is readable:
 *
 * - a real Git repository whose only bug is that `parseDate` returns an
 *   `Invalid Date` instead of rejecting one;
 * - a real CI file with two `node --test` steps, so both gates are ones this
 *   machine can actually execute without installing anything;
 * - a real implementation loop that writes the fix and the regression test, and
 *   then watches its own check pass;
 * - real verification gates, whose verdicts are exit codes and nothing else.
 *
 * There is no always-PASS shortcut anywhere in here, and one would be caught:
 * the regression test fails against the base commit's `parseDate`, so if the
 * loop's write were skipped, dropped or reverted, VG-001 would report exit 1 and
 * the trace asserted below would stop being VERIFIED.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/** The buggy original: it never rejects, so an unparseable string becomes Invalid Date. */
const BASE_IMPL = 'export function parseDate(value) {\n  return new Date(value);\n}\n';

/** What the loop writes. Any other content makes the regression test below fail. */
const FIXED_IMPL =
  'export function parseDate(value) {\n' +
  '  const date = new Date(value);\n' +
  '  if (Number.isNaN(date.getTime())) {\n' +
  '    throw new TypeError(`not a date: ${value}`);\n' +
  '  }\n' +
  '  return date;\n' +
  '}\n';

/** Fails on `BASE_IMPL`, passes on `FIXED_IMPL` — the point of the whole fixture. */
const REGRESSION_TEST =
  "import assert from 'node:assert/strict';\n" +
  "import test from 'node:test';\n" +
  "import { parseDate } from '../src/date.mjs';\n" +
  '\n' +
  "test('an unparseable string is rejected with a TypeError', () => {\n" +
  "  assert.throws(() => parseDate(''), TypeError);\n" +
  "  assert.throws(() => parseDate('not-a-date'), TypeError);\n" +
  '});\n';

/** Already true at the base commit, and must stay true: the "nothing else broke" gate. */
const EXISTING_TEST =
  "import assert from 'node:assert/strict';\n" +
  "import test from 'node:test';\n" +
  "import { parseDate } from '../src/date.mjs';\n" +
  '\n' +
  "test('a valid ISO date keeps its instant', () => {\n" +
  "  assert.equal(parseDate('2026-09-25T00:00:00.000Z').toISOString(), '2026-09-25T00:00:00.000Z');\n" +
  '});\n';

const HERO_FILES = {
  'package.json': JSON.stringify({ name: 'datekit', type: 'module', engines: { node: '>=22' } }),
  'src/date.mjs': BASE_IMPL,
  'test/valid.test.mjs': EXISTING_TEST,
  '.gitignore': '.mergesutra/\n',
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  checks:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Regression',
    '        run: node --test test/invalid.test.mjs',
    '      - name: Suite',
    '        run: node --test',
    '',
  ].join('\n'),
};

/** The two requirements a human states, each with the command that would prove it. */
const STATED: readonly InjectedCriterion[] = [
  {
    statement: 'An unparseable date string is rejected with a TypeError.',
    by: 'pavithran (issue reporter)',
    requirementType: 'functional',
    check: { command: 'node --test test/invalid.test.mjs', kind: 'test' },
  },
  {
    statement: 'A valid ISO date still parses to the same instant.',
    by: 'pavithran (issue reporter)',
    requirementType: 'functional',
    check: { command: 'node --test', kind: 'test' },
  },
];

const PLAN_BODY = {
  summary: 'Reject an unparseable string at the parser instead of returning Invalid Date.',
  rootCause: '`parseDate` hands the value straight to `new Date` and never checks the result.',
  changes: [
    {
      file: 'src/date.mjs',
      action: 'modify',
      reason: 'throw a TypeError when the constructed date is invalid',
      criterionIds: ['AC-2'],
    },
    {
      file: 'test/invalid.test.mjs',
      action: 'create',
      reason: 'keep the rejection observable by CI',
      criterionIds: ['AC-1', 'AC-2'],
    },
  ],
  validationCommands: [
    {
      argv: ['node', '--test', 'test/invalid.test.mjs'],
      purpose: 'prove the rejection',
      criterionIds: ['AC-1', 'AC-2'],
    },
    { argv: ['node', '--test'], purpose: 'prove nothing else broke', criterionIds: ['AC-3'] },
  ],
  criteriaCovered: ['AC-1', 'AC-2', 'AC-3'],
  criteriaUnaddressed: [],
  proposedCriteria: [],
  risks: ['A caller that relied on Invalid Date now receives an exception.'],
  assumptions: ['`parseDate` has one implementation, in src/date.mjs.'],
  questionsForHuman: [],
};

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

describe.skipIf(!AVAILABLE)(
  'the Stage 7 hero run: requirement to change to receipt to evidence',
  () => {
    it('closes the trace on real Git, real gates and a real patch', async () => {
      // ---- Stages 1-3: a repository, and a contract nobody had to interpret. ----
      const { dir: repo, base } = await initRepository(HERO_FILES);
      tempDirs.push(repo);
      const store = memoryRunStore();

      const inspected = await runInspect(
        { repoPath: repo },
        { run: defaultRunner, store, now: () => NOW },
      );
      const contracted = await runContractStage(
        { runId: inspected.record.runId, injectedCriteria: STATED },
        { store, now: () => NOW },
      );
      const criteria = contracted.acceptanceContract?.criteria ?? [];
      const runId = contracted.record.runId;
      // AC-1 is the repository's own `test` demand, quoted from its CI file;
      // AC-2 and AC-3 are the two requirements a human stated with a command.
      expect(criteria.map((criterion) => criterion.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
      expect(criteria.every((criterion) => criterion.evidence.length === 0)).toBe(true);

      // ---- Stage 4: a plan from the local test stub. ----
      const planned = await runPlanStage(
        { runId },
        { store, now: () => NOW, random: () => 0.5, client: scriptedClient([PLAN_BODY]) },
      );
      // Each stage issues its own run id; the workspace, patch and receipts all
      // hang off the one the implementation recorded.
      const implementedRunId = planned.record.runId;

      // ---- Stage 6: the loop writes the fix, the test, then runs its own check. ----
      const implemented = await runImplementStage(
        { runId: implementedRunId },
        {
          store,
          cwd: repo,
          now: () => NOW,
          client: scriptedClient([
            writeAction('src/date.mjs', FIXED_IMPL, ['AC-2'], digestOf(BASE_IMPL)),
            writeAction('test/invalid.test.mjs', REGRESSION_TEST),
            checkAction(['node', '--test', 'test/invalid.test.mjs'], 'see the rejection hold'),
            finishAction('parseDate now rejects; the regression test covers it.', ['AC-2', 'AC-3']),
          ]),
        },
      );
      expect(implemented.implementation.status).toBe('COMPLETED_BY_MODEL');
      expect(implemented.implementation.changes.map((change) => change.relativePath)).toEqual([
        'src/date.mjs',
        'test/invalid.test.mjs',
      ]);
      // The loop's own check is a fact it observed, not a verdict anyone else may reuse.
      const checked = implemented.implementation.actions.find((a) => a.action === 'RUN_CHECK');
      expect(checked?.outcome).toBe('CHECK_PASSED');

      // ---- Stage 7, first pass: nothing runs because nobody said yes. ----
      const blocked = await runVerifyStage({ runId: implementedRunId }, { store, now: () => NOW });
      expect(blocked.plan.gates.map((gate) => gate.command)).toEqual([
        'node --test test/invalid.test.mjs',
        'node --test',
        'git diff --check',
      ]);
      expect(blocked.run.result).toBe('BLOCKED');
      expect(
        blocked.run.gates.filter((gate) => gate.requiresConsent).map((gate) => gate.gateId),
      ).toEqual(['VG-001', 'VG-002']);
      expect(blocked.evidence.criteria.every((entry) => entry.status !== 'PASS')).toBe(true);

      // ---- Stage 7, second pass: the operator names the two repository gates. ----
      const stage = await runVerifyStage(
        { runId: implementedRunId, allow: ['VG-001', 'VG-002'] },
        { store, now: () => NOW },
      );

      // Every verdict below came out of a process this machine really started.
      for (const gate of stage.run.gates) {
        expect(gate.receipt.termination, gate.gateId).toBe('EXITED');
        expect(gate.receipt.exitCode, gate.gateId).toBe(0);
      }
      expect(stage.run.result).toBe('PASS');
      expect(stage.run.patchPrecondition.status).toBe('MATCHED');
      expect(stage.run.contamination).toBeNull();
      // The regression test's own name is in the output the receipt kept, so the
      // PASS cannot be a stubbed success: only a real run printed that line.
      expect(
        stage.run.gates.find((gate) => gate.gateId === 'VG-001')?.receipt.stdoutSummary,
      ).toContain('an unparseable string is rejected with a TypeError');

      // ---- The trace: which receipt carried which requirement. ----
      const byId = new Map(
        stage.evidence.criteria.map((entry) => [entry.criterionId, entry.gateIds]),
      );
      expect(byId.get('AC-1')).toEqual(['VG-001']);
      expect(byId.get('AC-2')).toEqual(['VG-001']);
      expect(byId.get('AC-3')).toEqual(['VG-002']);
      expect(stage.evidence.criteria.map((entry) => entry.sufficiency)).toEqual([
        'VERIFIED',
        'VERIFIED',
        'VERIFIED',
      ]);
      expect(stage.evidence.verification).toBe('PASS');
      expect(stage.evidence.contributionReady).toBe(false);

      // ---- What a human sees. ----
      const report = formatVerification(stage, createRenderer({ color: false }));
      expect(report).toMatch(/AC-1\s+VERIFIED\s+gates: VG-001/);
      expect(report).toMatch(/AC-2\s+VERIFIED\s+gates: VG-001/);
      expect(report).toMatch(/AC-3\s+VERIFIED\s+gates: VG-002/);
      expect(report).toMatch(/VG-001\s+node --test test\/invalid\.test\.mjs\s+exit 0/);
      expect(report).toMatch(/VG-003\s+git diff --check\s+exit 0/);
      expect(report).toContain('What the model said (a claim; decided nothing)');
      expect(report).not.toMatch(/CONTRIBUTION_READY/);

      // The README's Stage 7 capture is this run's real stdout, nothing else:
      // `MERGESUTRA_HERO_CAPTURE=1 npx vitest run tests/verify/hero.test.ts`.
      if (process.env.MERGESUTRA_HERO_CAPTURE) process.stdout.write(`${report}\n`);

      // ---- The fixture has teeth: the same test, run against the base commit's
      // code, fails. Without this line, "VERIFIED" above would only prove that a
      // gate is capable of agreeing with whatever happened to be on disk.
      await put(repo, 'test/invalid.test.mjs', REGRESSION_TEST);
      const againstTheBug = await createRunner({ cwd: repo })('node', [
        '--test',
        'test/invalid.test.mjs',
      ]);
      expect(againstTheBug.code, 'the regression test passes without the fix').not.toBe(0);

      // The patch this evidence describes is the base commit's own diff.
      expect(stage.plan.baseSha).toBe(base);
      expect(stage.plan.patchIdentity).toMatch(/^[0-9a-f]{64}$/);
      expect(stage.record.outcome).toBe('VERIFICATION_PASS');
      expect(stage.record.nextStage).toMatch(/REVIEW/);
    }, 600_000);
  },
);
