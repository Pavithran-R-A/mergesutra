import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReviewDocument, reviewBodySchema } from '../../src/review/schema.js';
import { describePatch } from '../../src/verify/patch.js';
import { runVerifyStage } from '../../src/verify/stage.js';
import { recordWith } from './review.js';
import { frozenPlan } from './repair.js';
import { digestOf, finishAction, planTouching, writeAction } from './implement.js';
import { implementedRun, scriptedGates, NOW, put } from './verifyRun.js';
import type { RepairPlan } from '../../src/repair/plan.js';
import type { RunRecord } from '../../src/state/run-record.js';

/**
 * A run that has been reviewed and has a plan frozen against its bytes.
 *
 * Stage 9R's orchestrator and its command line are judged against the same
 * fixture, because the thing worth proving is that the command does not have a
 * softer path to the same transition than the module does. Handing one of them a
 * hand-written record would let a CLI-level bug — a missing flag, a consent that
 * never arrives — pass in the file that a person actually types in.
 *
 * So everything here is measured from a real Git workspace: Stage 7 runs twice
 * (once unconsented, once with the repository gates named) so the digest a repair
 * has to live under is the one the product derived, and the frozen plan names the
 * gates and files that plan builder really produced. Only the model is scripted.
 */

/** What the repair writes over the fixture's parser: the branch the criterion asks for. */
export const REPAIRED =
  'export function parseDate(i: string): Date {\n' +
  '  if (!i) throw new TypeError("empty");\n' +
  '  const d = new Date(i);\n' +
  '  if (Number.isNaN(d.getTime())) throw new TypeError(i);\n' +
  '  return d;\n' +
  '}\n';

/**
 * When the human said yes: an hour before the repair's own clock.
 *
 * A consent minted by the round it authorises is indistinguishable from one the
 * human gave, unless the two carry different times. Real ones always do — verify
 * ran, a person read its plan, then the repair ran later — so the fixture says so
 * too, and "the stage handed the stored yes over" becomes a claim a test can
 * falsify rather than one about an object an implementation could fake in passing.
 */
export const GRANTED_AT = '2026-09-25T08:00:00.000Z';

export interface RepairFixture {
  readonly workspace: string;
  /** Outside the repository: a pack written inside it would join the patch. */
  readonly runsRoot: string;
  readonly store: Awaited<ReturnType<typeof implementedRun>>['prepared']['store'];
  readonly record: RunRecord;
  readonly plan: RepairPlan;
  readonly identityA: string;
  readonly criteria: readonly string[];
  readonly repoGateIds: readonly string[];
  readonly base: string;
  /** Every command the gate engine was asked to start, across all rounds. */
  readonly gateCalls: string[];
  /** The scripted answer those commands get, for the round after the repair. */
  readonly runFor: ReturnType<typeof scriptedGates>['runFor'];
}

export async function reviewedRun(
  tempDirs: string[],
  options: {
    readonly findings?: boolean;
    readonly movePatchAfterPlan?: boolean;
    readonly reviewCycle?: number;
  } = {},
): Promise<RepairFixture> {
  const { prepared, source, repoDir, base } = await implementedRun(tempDirs);
  const gates = scriptedGates();
  const learning = await runVerifyStage(
    { runId: source.runId },
    { store: prepared.store, now: () => NOW, ...gates },
  );
  const repoGateIds = learning.plan.gates
    .filter((gate) => gate.provenance.source !== 'MERGESUTRA_BUILTIN')
    .map((gate) => gate.id);
  const verified = await runVerifyStage(
    { runId: source.runId, allow: repoGateIds },
    { store: prepared.store, now: () => NOW, ...gates },
  );

  const patch = await describePatch({ workspace: repoDir, baseSha: base });
  const criteria = prepared.contract.criteria.map((criterion) => criterion.id);
  const plan = frozenPlan({
    runId: source.runId,
    criteria,
    patchIdentity: patch.identity,
    expectedChecks: repoGateIds,
    reviewCycle: options.reviewCycle,
    createdAt: NOW.toISOString(),
  });
  // A run that reached a review has a Stage 4 plan beside it — the loop the repair
  // cycle uses takes that plan for its prompt, and the brief for its scope.
  const granted = verified.record.executionConsent;
  if (!granted) throw new Error('the consented verify round filed no consent to carry forward');
  const record = recordWith(verified.record, {
    plan: planTouching(['src/parse.ts', 'test/parse.test.ts']),
    stage: 'review',
    outcome: 'REVIEW_RECORDED',
    review: reviewOf(source, plan, patch.identity, base, options.findings !== false),
    repairPlan: plan,
    executionConsent: { ...granted, grantedAt: GRANTED_AT },
  });
  await prepared.store.save(record);

  if (options.movePatchAfterPlan) {
    await put(repoDir, 'notes.md', 'a person wrote here after the plan was frozen\n');
  }

  const runsRoot = await mkdtemp(path.join(tmpdir(), 'mergesutra-repair-runs-'));
  tempDirs.push(runsRoot);

  return {
    workspace: repoDir,
    runsRoot,
    store: prepared.store,
    record,
    plan,
    identityA: patch.identity,
    criteria,
    repoGateIds,
    base,
    gateCalls: gates.calls,
    runFor: gates.runFor,
  };
}

function reviewOf(
  source: RunRecord,
  plan: RepairPlan,
  identity: string,
  baseSha: string,
  withCandidate: boolean,
) {
  const findings = withCandidate
    ? [
        {
          severity: 'HIGH',
          category: 'REQUIREMENT_GAP',
          statement: 'The parser still returns a Date where the criterion asks for an error.',
          impact: 'A caller gets a wrong instant instead of a rejection.',
          evidence: 'src/parse.ts throws only on an empty string.',
          file: 'src/parse.ts',
          criterionIds: [...plan.criteria],
          contextRefs: ['CTX-001'],
          proposedAction: 'Reject input Date cannot represent.',
        },
      ]
    : [];
  return buildReviewDocument({
    runId: source.runId,
    baseSha,
    reviewedPatchIdentity: identity,
    currentPatchIdentity: identity,
    modelId: 'scripted-review-model',
    reviewedAt: NOW.toISOString(),
    attempts: 1,
    body: reviewBodySchema.parse({
      summary: withCandidate
        ? 'One gap against the contract.'
        : 'Nothing to report on these bytes.',
      findings,
    }),
    dispositions: findings.map((finding, index) => ({
      index,
      disposition:
        finding.severity === 'HIGH'
          ? ('VALID_REPAIR_CANDIDATE' as const)
          : ('NEEDS_HUMAN_REVIEW' as const),
      reason: 'Cited material MergeSutra checked, and names a file a repair can aim at.',
    })),
  });
}

/** The model's two turns: edit the one file the plan names, then claim it is finished. */
export function repairedAnswers(current: string, criteria: readonly string[]) {
  return [
    writeAction('src/parse.ts', REPAIRED, [...criteria], digestOf(current)),
    finishAction('Rewrote the guard so unparseable input is rejected.', [...criteria]),
  ];
}

export async function parserOf(workspace: string): Promise<string> {
  return readFile(path.join(workspace, 'src/parse.ts'), 'utf8');
}
