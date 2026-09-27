import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRunner, defaultRunner } from '../../src/core/runner.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runPlanStage } from '../../src/plan/plan.js';
import { runImplementStage } from '../../src/implement/implement.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import { runReviewStage } from '../../src/review/stage.js';
import { runReportStage } from '../../src/cli/report.js';
import { createFileRunStore, defaultRunStoreRoot } from '../../src/state/run-store.js';
import { describePatch } from '../../src/verify/patch.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { classifyRepairScope, routeRepairScope } from '../../src/repair/scope.js';
import { repairPlanDigest } from '../../src/repair/digest.js';
import { runRepairStage } from '../../src/repair/stage.js';
import { formatReview } from '../../src/cli/review.js';
import { formatRepair } from '../../src/cli/repair.js';
import { createRenderer } from '../../src/cli/render.js';
import { checkAction, digestOf, finishAction, writeAction } from '../helpers/implement.js';
import { scriptedClient } from '../helpers/bharatcode.js';
import { hasGit, initRepository } from '../helpers/git.js';
import { memoryRunStore } from '../helpers/github.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { reviewFixture, type ReviewFixture } from '../helpers/review.js';
import type { BharatCodeClient } from '../../src/bharatcode/client.js';
import type { InjectedCriterion } from '../../src/contract/derive.js';

/**
 * The Stage 9 hero: gates that were green, a reviewer that disagreed, and the
 * run re-measured afterwards.
 *
 * Stages 7 and 8 each have a hero that stops at the honest limit of what a green
 * suite establishes. This file starts there. The patch below passes every gate
 * the repository declares — and the requirement it was written for asks for a
 * thing no gate ever tests, so `VERIFIED` on that row is exactly the kind of
 * true statement that misleads. A second reader is shown those bytes, says so,
 * and MergeSutra turns that into a scope frozen before any edit.
 *
 * Then the part that matters: the repair really happens, through Stage 6's own
 * bounded loop and its own confined writer rather than a second editor with
 * separate powers, and every downstream fact has to be re-earned. The review of
 * the old bytes is not a review of the new ones. The old receipts do not answer
 * for the new bytes. The pack written before the edit does not describe the
 * workspace after it. Each of those is checked against real Git objects and real
 * `node --test` processes, because a lifecycle this easy to short-circuit cannot
 * be trusted to a comment saying it was followed.
 *
 * Only the model calls are scripted, and for the standing reason: no credential
 * belongs in a test run (§32), and a model's agreement is not evidence either way.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/** What the repository ships: an unparseable string becomes an Invalid Date. */
const BASE_IMPL = 'export function parseDate(value) {\n  return new Date(value);\n}\n';

/**
 * The patch Stage 6 writes on its first pass. Every declared gate passes on it,
 * and `parseDate('2026-02-30')` answers `2026-03-02T00:00:00.000Z` — the bug the
 * issue was opened about.
 */
const GUARD_ONLY_IMPL =
  'export function parseDate(value) {\n' +
  '  const date = new Date(value);\n' +
  '  if (Number.isNaN(date.getTime())) {\n' +
  '    throw new TypeError(`not a date: ${value}`);\n' +
  '  }\n' +
  '  return date;\n' +
  '}\n';

/** What the repair writes: the rollover is caught, not only the unparseable. */
const REPAIRED_IMPL =
  'const DATE_PREFIX = /^(\\d{4})-(\\d{2})-(\\d{2})/;\n' +
  '\n' +
  'export function parseDate(value) {\n' +
  '  const date = new Date(value);\n' +
  '  if (Number.isNaN(date.getTime())) {\n' +
  '    throw new TypeError(`not a date: ${value}`);\n' +
  '  }\n' +
  '  const parts = DATE_PREFIX.exec(value);\n' +
  '  if (parts) {\n' +
  '    const daysInMonth = new Date(Number(parts[1]), Number(parts[2]), 0).getDate();\n' +
  '    if (Number(parts[3]) > daysInMonth) {\n' +
  '      throw new RangeError(`no such day: ${value}`);\n' +
  '    }\n' +
  '  }\n' +
  '  return date;\n' +
  '}\n';

/** Every version of the test file opens the same way. */
const PROLOGUE =
  "import assert from 'node:assert/strict';\n" +
  "import test from 'node:test';\n" +
  "import { parseDate } from '../src/date.mjs';\n" +
  '\n';

const STILL_GOOD_TEST =
  "test('a valid ISO date keeps its instant', () => {\n" +
  "  assert.equal(parseDate('2026-09-25T00:00:00.000Z').toISOString(), '2026-09-25T00:00:00.000Z');\n" +
  '});\n';

const UNPARSEABLE_TEST =
  "test('an unparseable string is rejected', () => {\n" +
  "  assert.throws(() => parseDate('not-a-date'), TypeError);\n" +
  '});\n';

/** True of every implementation above, so "nothing else broke" stays an honest gate. */
const EXISTING_TEST = PROLOGUE + STILL_GOOD_TEST;

/** What the first pass writes into the plan's test file: the guard, and only it. */
const GUARD_TEST = PROLOGUE + UNPARSEABLE_TEST + STILL_GOOD_TEST;

/**
 * What the repair adds to that file. Fails against `GUARD_ONLY_IMPL`, passes
 * against `REPAIRED_IMPL` — the fixture's teeth, checked at the end of the run.
 */
const REPAIRED_TEST =
  PROLOGUE +
  "test('an impossible day is rejected', () => {\n" +
  "  assert.throws(() => parseDate('2026-02-30'), RangeError);\n" +
  "  assert.throws(() => parseDate('2026-02-30T00:00:00'), RangeError);\n" +
  '});\n' +
  UNPARSEABLE_TEST +
  STILL_GOOD_TEST;

const HERO_FILES = {
  'package.json': JSON.stringify({ name: 'datekit', type: 'module', engines: { node: '>=22' } }),
  'src/date.mjs': BASE_IMPL,
  'test/parse.test.mjs': EXISTING_TEST,
  '.gitignore': '.mergesutra/\n',
  '.github/workflows/ci.yml': [
    'name: ci',
    'on: [push]',
    'jobs:',
    '  checks:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - name: Parser',
    '        run: node --test test/parse.test.mjs',
    '      - name: Suite',
    '        run: node --test',
    '',
  ].join('\n'),
};

/** The two requirements a human states, each with the command that proves it. */
const STATED: readonly InjectedCriterion[] = [
  {
    statement: 'An impossible calendar day is rejected rather than rolled over.',
    by: 'pavithran (issue reporter)',
    requirementType: 'functional',
    check: { command: 'node --test', kind: 'test' },
  },
  {
    statement: 'An unparseable date string is rejected with a TypeError.',
    by: 'pavithran (issue reporter)',
    requirementType: 'functional',
    check: { command: 'node --test test/parse.test.mjs', kind: 'test' },
  },
];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/** The reviewer, with every citation read off the page it was actually shown. */
function reviewer(make: (wire: string) => readonly Record<string, unknown>[]): BharatCodeClient {
  return {
    async complete(request) {
      const wire = request.messages.map((message) => message.content).join('\n');
      return {
        text: JSON.stringify({
          summary:
            'The guard catches strings that are not dates at all; a day the calendar does not have still rolls into the next month.',
          findings: make(wire),
        }),
        model: 'bharatcode-deepseek-reviewer',
        finishReason: 'stop',
        usage: { promptTokens: 6_100, completionTokens: 340, totalTokens: 6_440 },
      };
    },
    async listModels() {
      throw new Error('the reviewer may not enumerate models');
    },
    async completeStructured() {
      throw new Error('the reviewer may not ask for structured output');
    },
    async healthCheck() {
      throw new Error('the reviewer may not probe the service');
    },
  };
}

function refNaming(wire: string, file: string): string {
  const found = new RegExp(`(CTX-\\d{3}) type: PATCH file: ${file.replace(/\./g, '\\.')}\\b`).exec(
    wire,
  );
  if (!found?.[1]) throw new Error(`the reviewed page names no reference for ${file}`);
  return found[1];
}

/** A finding anchored on `file`, citing the reference the prompt printed for it. */
function anchored(
  file: string,
  criterionId: string,
  over: Record<string, unknown>,
): (wire: string) => Record<string, unknown> {
  return (wire) => ({
    severity: 'HIGH',
    confidence: 'HIGH',
    file,
    criterionIds: [criterionId],
    contextRefs: [refNaming(wire, file)],
    ...over,
  });
}

/** The defect, and the missing coverage that let it through. */
const greenButWrong =
  (impossibleDayId: string) =>
  (wire: string): Record<string, unknown>[] => [
    anchored('src/date.mjs', impossibleDayId, {
      category: 'CORRECTNESS',
      statement: 'A calendar day that does not exist is rolled into the next month, not rejected.',
      impact: 'A caller stores 2 March for an input that meant 30 February, and never hears.',
      evidence:
        'The only rejection is the NaN check, and an out-of-range day still constructs a real instant.',
      proposedAction:
        'Change src/date.mjs to compare the day in the input with the number of days in that month, and reject it when it exceeds them.',
    })(wire),
    anchored('test/parse.test.mjs', impossibleDayId, {
      category: 'TEST_GAP',
      statement: 'Nothing in the patch gives the parser an impossible day.',
      impact: 'A green suite is then read as covering the one requirement the issue is about.',
      evidence: "The patch's test file asserts the unparseable-string case only.",
      proposedAction:
        'Add to test/parse.test.mjs a case asserting that parseDate("2026-02-30") rejects.',
    })(wire),
  ];

describe.skipIf(!AVAILABLE)(
  'the Stage 9 hero: green gates, a real defect, a re-measured run',
  () => {
    it('takes a passing patch through review, repair and verification of what the repair left', async () => {
      // ---- Stages 1-3, on real Git, into a real run store on disk. ----
      const { dir: repo, base } = await initRepository(HERO_FILES);
      tempDirs.push(repo);
      const storeRoot = await mkdtemp(path.join(tmpdir(), 'mergesutra-review-store-'));
      tempDirs.push(storeRoot);
      const store = createFileRunStore(defaultRunStoreRoot(storeRoot));

      const inspected = await runInspect(
        { repoPath: repo },
        { run: defaultRunner, store, now: () => NOW },
      );
      const contracted = await runContractStage(
        { runId: inspected.record.runId, injectedCriteria: STATED },
        { store, now: () => NOW },
      );
      const criteria = contracted.acceptanceContract?.criteria ?? [];
      const impossibleDay = criteria.find((criterion) =>
        criterion.statement.toLowerCase().includes('impossible'),
      );
      if (!impossibleDay) throw new Error('the contract lost the requirement the issue is about');
      const ids = criteria.map((criterion) => criterion.id);

      // ---- Stage 4: a plan that means to change the source and its test file. ----
      const planned = await runPlanStage(
        { runId: contracted.record.runId },
        {
          store,
          now: () => NOW,
          random: () => 0.5,
          client: scriptedClient([
            {
              summary: 'Reject unparseable input at the parser instead of returning Invalid Date.',
              rootCause: '`parseDate` hands the value to `new Date` and never checks the result.',
              changes: [
                {
                  file: 'src/date.mjs',
                  action: 'modify',
                  reason: 'throw when the constructed date is not a date',
                  criterionIds: ids,
                },
                {
                  file: 'test/parse.test.mjs',
                  action: 'modify',
                  reason: 'keep the rejection observable in CI',
                  criterionIds: ids,
                },
              ],
              validationCommands: [
                { argv: ['node', '--test'], purpose: 'run the suite', criterionIds: ids },
              ],
              criteriaCovered: ids,
              criteriaUnaddressed: [],
              proposedCriteria: [],
              risks: ['A caller that relied on Invalid Date now receives an exception.'],
              assumptions: ['`parseDate` has one implementation, in src/date.mjs.'],
              questionsForHuman: [],
            },
          ]),
        },
      );
      const runId = planned.record.runId;

      // ---- Stage 6: the loop writes the guard and its test, and watches them pass. ----
      const first = await runImplementStage(
        { runId },
        {
          store,
          cwd: repo,
          now: () => NOW,
          client: scriptedClient([
            writeAction('src/date.mjs', GUARD_ONLY_IMPL, ids, digestOf(BASE_IMPL)),
            writeAction('test/parse.test.mjs', GUARD_TEST, ids, digestOf(EXISTING_TEST)),
            checkAction(['node', '--test'], 'see the guard hold'),
            finishAction('parseDate now rejects unparseable input; the test covers it.', ids),
          ]),
        },
      );
      const workspace = first.workspace.path;

      // ---- Stage 7: the repository's own gates, run for real. ----
      const firstVerification = await runVerifyStage(
        { runId, allow: ['VG-001', 'VG-002'] },
        { store, now: () => NOW },
      );
      const patchA = await describePatch({ workspace, baseSha: base });
      // The whole premise of this stage, in one assertion: every gate passed.
      expect(firstVerification.run.result).toBe('PASS');
      const firstRow = firstVerification.evidence.criteria.find(
        (entry) => entry.criterionId === impossibleDay.id,
      );
      // …and the requirement the issue was opened about is VERIFIED by a gate that
      // never once handed the parser an impossible day.
      expect(firstRow?.sufficiency).toBe('VERIFIED');
      expect(firstRow?.gateIds).toEqual(['VG-002']);

      // ---- Stage 9: a second reader, shown exactly those bytes. ----
      const reviewed = await runReviewStage(
        { runId },
        { store, now: () => NOW, client: reviewer(greenButWrong(impossibleDay.id)) },
      );
      expect(path.resolve(reviewed.workspace)).toBe(path.resolve(workspace));
      expect(reviewed.attempt.status).toBe('REVIEWED');
      expect(reviewed.attempt.patchPrecondition).toBe('MATCHED');
      const review = reviewed.review;
      const plan = reviewed.repairPlan;
      if (!review || !plan) throw new Error('the review filed nothing it could route');

      expect(review.findings.map((entry) => entry.disposition)).toEqual([
        'VALID_REPAIR_CANDIDATE',
        'VALID_REPAIR_CANDIDATE',
      ]);
      expect(plan.expectedFiles).toEqual(['src/date.mjs', 'test/parse.test.mjs']);
      expect(plan.expectedChecks).toEqual(['VG-002']);
      expect(reviewed.record.outcome).toBe('REVIEW_RECORDED');
      // Freezing a plan is a decision about a later edit, not an edit. The bytes
      // the reviewer read are still the bytes on disk.
      expect((await describePatch({ workspace, baseSha: base })).identity).toBe(patchA.identity);

      // ---- Stage 9R, unpaid for: a frozen plan is not yet permission to edit. ----
      const refused = await runRepairStage(
        { runId },
        { store, cwd: repo, now: () => NOW, client: scriptedClient([]) },
      );
      expect(refused.executed).toBe(false);
      expect(refused.decision.status).toBe('ABSENT');
      expect(refused.decision.expectedDigest).toBe(repairPlanDigest(plan));
      // A run nobody approved is the run it was before the command was typed: no
      // record rewritten, no pack touched, no byte moved.
      expect(refused.recordFile).toBeNull();
      expect(refused.packDir).toBeNull();
      expect((await store.load(runId)).repairExecutions).toEqual([]);
      expect((await describePatch({ workspace, baseSha: base })).identity).toBe(patchA.identity);

      // ---- Stage 9R, paid for: the digest of that plan, typed after reading it. ----
      const repaired = await runRepairStage(
        { runId, approvePlan: repairPlanDigest(plan) },
        {
          store,
          cwd: repo,
          now: () => NOW,
          runsRoot: defaultRunStoreRoot(storeRoot),
          client: scriptedClient([
            writeAction(
              'src/date.mjs',
              REPAIRED_IMPL,
              [impossibleDay.id],
              digestOf(GUARD_ONLY_IMPL),
            ),
            writeAction(
              'test/parse.test.mjs',
              REPAIRED_TEST,
              [impossibleDay.id],
              digestOf(GUARD_TEST),
            ),
            checkAction(['node', '--test'], 'see the impossible day rejected'),
            finishAction('parseDate now rejects a day the calendar does not have.', ids),
          ]),
        },
      );
      const patchB = await describePatch({ workspace, baseSha: base });
      expect(repaired.executed).toBe(true);
      expect(repaired.decision.status).toBe('MATCHED');
      const execution = repaired.execution;
      if (!execution) throw new Error('an approved cycle filed no execution');
      // One editing engine, not a second one with separate powers: Stage 6's loop,
      // Stage 5's confined writer, the workspace this run already owns.
      expect(execution.implementation.workspace.relativePath).toBe(first.workspace.relativePath);
      expect(execution.planDigest).toBe(repairPlanDigest(plan));
      expect(execution.patchBeforeIdentity).toBe(patchA.identity);
      expect(execution.patchAfterIdentity).toBe(patchB.identity);
      expect(execution.patchChanged).toBe(true);
      expect(execution.verificationRequired).toBe(true);
      expect(patchB.identity).not.toBe(patchA.identity);

      // The scope guard, over the delta the plan described in advance — and the
      // delta on the filed execution is the guard's own reading of the two real
      // patches, not a summary the cycle wrote down for itself.
      expect(execution.scope).toEqual(
        classifyRepairScope({ plan, patchBefore: patchA, patchAfter: patchB }),
      );
      expect(execution.scope.outcome).toBe('WITHIN_PLANNED_SCOPE');
      expect(execution.scope.unexpectedFiles).toEqual([]);
      expect(
        execution.scope.files.filter((file) => file.delta !== 'UNCHANGED').map((file) => file.path),
      ).toEqual(['src/date.mjs', 'test/parse.test.mjs']);
      expect(routeRepairScope(execution.scope)).toBe('REVERIFY_THROUGH_STAGE_7');

      // ---- Stage 7 ran again on those bytes, under the consent already on file. ----
      // No `allow` is typed anywhere below: the only reason a repository gate may
      // have started is §16 reuse — the same commands, so the same scope digest.
      const round = repaired.round;
      if (!round) throw new Error('a patch-changing cycle owed a re-verification and got none');
      expect(round.plan.patchIdentity).toBe(patchB.identity);
      expect(round.run.result).toBe('PASS');
      expect(round.run.patchPrecondition.status).toBe('MATCHED');
      // A gate that never started would make the round BLOCKED, so the line above
      // is the proof; this states the same fact where a reader is looking for it.
      expect(round.run.gates.map((gate) => gate.receipt.termination)).not.toContain('NOT_EXECUTED');
      // New receipts for new bytes: every one of them names patch B.
      expect([...new Set(round.run.gates.map((gate) => gate.receipt.patchIdentity))]).toEqual([
        patchB.identity,
      ]);
      // And the suite that gate ran now carries the impossible-day assertion, in
      // the output of the process that really executed it.
      expect(
        round.run.gates.find((gate) => gate.gateId === 'VG-002')?.receipt.stdoutSummary,
      ).toContain('an impossible day is rejected');

      // ---- Evidence remapped: the requirement is now VERIFIED by a gate that ran it. ----
      const remapped = repaired.record.evidence?.criteria.find(
        (entry) => entry.criterionId === impossibleDay.id,
      );
      expect(remapped?.sufficiency).toBe('VERIFIED');
      const remappingGate = round.run.gates.find((gate) => gate.gateId === remapped?.gateIds[0]);
      expect(remappingGate?.receipt.patchIdentity).toBe(patchB.identity);
      expect(repaired.record.verificationPlan?.patchIdentity).toBe(patchB.identity);
      expect(repaired.record.verification?.patchPrecondition.status).toBe('MATCHED');
      // The review of patch A survives as a review of patch A — carried, never
      // re-labelled as a reading of the bytes that exist now.
      expect(repaired.record.review?.reviewedPatchIdentity).toBe(patchA.identity);
      expect(repaired.record.repairExecutions).toHaveLength(1);
      expect(repaired.record.outcome).toBe('REPAIR_APPLIED');
      expect(repaired.record.nextStage).toMatch(/REVIEW/);

      // ---- Stage 8's pack, regenerated by the cycle that made the old one stale. ----
      expect(repaired.packError).toBeNull();
      if (!repaired.packDir)
        throw new Error('a filed cycle wrote no pack and said nothing about it');
      const afterRepair = await readFile(path.join(repaired.packDir, 'report.md'), 'utf8');
      expect(afterRepair).toContain('## Repair cycles');
      const cycleLine =
        afterRepair.split('\n').find((line) => line.includes('Repair cycle 1')) ?? '';
      // The rows above the cycle line were re-measured, so the line may not call
      // them stale: green and stale are different claims, and this one is green.
      expect(cycleLine).toContain(patchB.identity);
      expect(cycleLine).not.toMatch(/stale/i);
      // Patch A survives on the page, but only as history: the reading that made
      // the finding, the order frozen against those bytes, and the cycle that
      // started from them. The rows that carry verdicts are pinned to patch B,
      // which is what a reader of a pack needs the page to say out loud.
      expect(afterRepair).toContain(`- Patch: ${patchB.identity}`);
      const patchAReferences = afterRepair
        .split('\n')
        .filter((line) => line.includes(patchA.identity));
      expect(patchAReferences).toHaveLength(3);
      for (const line of patchAReferences) {
        expect(line).toMatch(/Reviewed patch:|review \/ 1 repair, against patch|Repair cycle 1/);
      }
      expect(afterRepair).not.toContain(`- Patch: ${patchA.identity}`);

      // ---- A second, independent reading of the bytes that exist now. ----
      const secondReview = await runReviewStage(
        { runId },
        { store, now: () => NOW, client: reviewer(() => []) },
      );
      expect(secondReview.attempt.status).toBe('REVIEWED');
      expect(secondReview.review?.reviewedPatchIdentity).toBe(patchB.identity);
      expect(secondReview.review?.findings).toEqual([]);
      // Nobody objected, so nothing was frozen and nothing was edited: the second
      // reading earns no more authority over the bytes than the first one did.
      expect(secondReview.repairPlan).toBeNull();
      expect((await describePatch({ workspace, baseSha: base })).identity).toBe(patchB.identity);
      expect(secondReview.record.outcome).toBe('REVIEW_RECORDED');
      // Routed onward, not run onward — Stage 10 is a later command's decision.
      expect(secondReview.record.nextStage).toMatch(/REPORT|PR|human/i);
      expect(JSON.stringify(secondReview.record)).not.toMatch(/CONTRIBUTION_READY|APPROVED/i);

      // ---- Stage 8 over the final record, read back off the disk it lives on. ----
      const pack = await runReportStage({ runId }, { cwd: storeRoot });
      expect((await readdir(pack.dir)).sort()).toEqual([
        'commands.jsonl',
        'report.json',
        'report.md',
      ]);
      const rendered = await readFile(path.join(pack.dir, 'report.md'), 'utf8');
      expect(rendered).toContain(patchB.identity);
      expect(rendered).toMatch(/Repair cycle 1/);
      // The second reviewer filed nothing, which the pack states as a limit on the
      // reading rather than as a clean bill of health.
      expect(rendered).toContain('The reviewer filed no findings');
      // What the pack may never say, in the words the Stage 8 suite bans too:
      // `approved` as a bare English adjective is a truthful description of a plan
      // a human digested, so the finding here is a verdict attributed to a model.
      expect(rendered).not.toMatch(/CONTRIBUTION_READY|AI APPROVED|approved by the model|LGTM/i);

      // What the operator saw at the review step, captured verbatim for the README.
      const report = formatReview(reviewed, createRenderer({ color: false }));
      expect(report).toContain('RF-001');
      expect(report).toContain('RF-002');
      expect(report).toContain('VALID_REPAIR_CANDIDATE');
      expect(report).toContain('Repair plan — frozen before any edit');
      expect(report).toMatch(/no file was changed here/i);
      expect(report).not.toMatch(/CONTRIBUTION_READY|APPROVED|LGTM/i);
      if (process.env.MERGESUTRA_HERO_CAPTURE) {
        process.stdout.write(`\n--- mergesutra review ${runId} ---\n${report}\n`);
        const cycle = repaired.record.repairExecutions[0];
        if (!cycle) throw new Error('the capture run filed no cycle to print');
        const screen = formatRepair(repaired, createRenderer({ color: false }));
        expect(screen).toContain('Re-verified');
        // "The operator approved this exact plan" is true and must stay; what the
        // screen may never say is that a model, or this stage, signed off on the
        // patch. Readiness is Stage 10's word, and no cycle here earns it.
        expect(screen).not.toMatch(/CONTRIBUTION_READY|LGTM|approved by the model/i);
        expect(screen).not.toMatch(/^\s*Outcome\s+\S*READY/im);
        process.stdout.write(
          `\n--- mergesutra repair ${runId} --approve-plan ${cycle.planDigest} ---\n${screen}\n`,
        );
        process.stdout.write(`\n--- evidence pack after the repair ---\n${rendered}`);
      }

      // ---- Teeth: the case the repair added fails against the patch it replaced. ----
      // Without this, the PASS above would only prove a gate can agree with
      // whatever happens to be on disk.
      await writeFile(path.join(workspace, 'src/date.mjs'), GUARD_ONLY_IMPL, 'utf8');
      const againstTheOldPatch = await createRunner({ cwd: workspace })('node', [
        '--test',
        'test/parse.test.mjs',
      ]);
      expect(againstTheOldPatch.code, 'the impossible-day case passes without the fix').not.toBe(0);
    }, 600_000);

    it('files a review that found nothing as a limit on the reading, and routes no work', async () => {
      const { record } = await aVerifiedRun();
      const store = memoryRunStore();
      await store.save(record);

      const reviewed = await runReviewStage(
        { runId: record.runId },
        { store, now: () => NOW, client: reviewer(() => []) },
      );

      expect(reviewed.record.outcome).toBe('REVIEW_RECORDED');
      expect(reviewed.review?.findings).toEqual([]);
      expect(reviewed.repairPlan).toBeNull();
      const pack = buildEvidencePack(reviewed.record);
      expect(pack.files['report.md']).toContain('The reviewer filed no findings');
      expect(pack.files['report.md']).not.toContain('## Repair plan');
      expect(pack.files['report.md']).not.toMatch(/CONTRIBUTION_READY|APPROVED/i);
      // Nobody objected is not nobody finished: the run still goes to a human.
      expect(reviewed.record.nextStage).toMatch(/REPORT/);
    });

    it('drops a finding about a file this patch does not contain, and freezes nothing from it', async () => {
      const { record } = await aVerifiedRun();
      const store = memoryRunStore();
      await store.save(record);

      const reviewed = await runReviewStage(
        { runId: record.runId },
        {
          store,
          now: () => NOW,
          client: reviewer(() => [
            {
              severity: 'BLOCKER',
              category: 'CORRECTNESS',
              statement: 'src/validator.ts never checks the day against the month.',
              impact: 'Every caller that goes through the validator keeps the bug.',
              evidence: 'A file the patch does not contain, named with complete confidence.',
              file: 'src/validator.ts',
              criterionIds: ['AC-1'],
              contextRefs: ['CTX-500'],
              proposedAction: 'Change src/validator.ts to validate the day.',
              confidence: 'HIGH',
            },
          ]),
        },
      );

      const filed = reviewed.review?.findings[0];
      expect(filed?.disposition).toBe('UNSUPPORTED');
      expect(filed?.dispositionReason).toMatch(/CTX-500|manifest|no reference/i);
      expect(reviewed.repairPlan).toBeNull();
      expect(reviewed.record.outcome).toBe('REVIEW_NEEDS_HUMAN');
      const pack = buildEvidencePack(reviewed.record);
      expect(pack.files['report.md']).toContain('UNSUPPORTED');
      expect(pack.files['report.md']).not.toContain('## Repair plan');
    });

    it('weighs the same defect twice as one candidate and one duplicate, and plans one edit', async () => {
      const { record } = await aVerifiedRun();
      const store = memoryRunStore();
      await store.save(record);
      const once = anchored('src/parse.ts', 'AC-1', {
        category: 'CORRECTNESS',
        statement: 'The parser builds a Date before the day is checked.',
        impact: 'An impossible day becomes a wrong day the caller cannot detect.',
        evidence: 'The only guard rejects strings that are not dates at all.',
        proposedAction: 'Change src/parse.ts to reject a day outside its month.',
      });
      const twice = (wire: string): Record<string, unknown>[] => {
        const one = once(wire);
        return [one, { ...one }];
      };

      const reviewed = await runReviewStage(
        { runId: record.runId },
        { store, now: () => NOW, client: reviewer(twice) },
      );

      expect(reviewed.review?.findings.map((entry) => entry.disposition)).toEqual([
        'VALID_REPAIR_CANDIDATE',
        'DUPLICATE',
      ]);
      // One defect earns one entry in the work order, so a model that repeated
      // itself cannot spin a second cycle out of the repetition.
      expect(reviewed.repairPlan?.findings.map((item) => item.findingId)).toEqual(['RF-001']);
      expect(reviewed.repairPlan?.reviewCycle).toBe(1);
      expect(reviewed.repairPlan?.repairCycle).toBe(1);
    });
  },
);

/**
 * A verified run for the three shorter cases, from the shared fixture.
 *
 * The hero measures every byte for real; these three ask one question each about
 * what MergeSutra does with an answer, and a real `node --test` run would add
 * seconds without adding a fact.
 */
async function aVerifiedRun(): Promise<ReviewFixture> {
  return reviewFixture(tempDirs);
}
