import { afterEach, describe, expect, it } from 'vitest';
import { runPlanStage } from '../../src/plan/plan.js';
import { parseImplementationPlan } from '../../src/plan/schema.js';
import { cleanUp, contractBackedRun, NOW } from '../helpers/plan.js';

/**
 * The only test in this repository that is allowed to reach the network, and it
 * stays silent unless it is explicitly invited:
 *
 * ```
 * MERGESUTRA_LIVE_BHARATCODE=1 BHARATCODE_API_KEY=… BHARATCODE_MODEL=… npm run test:live
 * ```
 *
 * Everything else in the suite runs against a scripted client, because a test
 * that depends on a model's mood is not a test. What this one checks is narrow
 * and structural: that a real answer still has to pass the same schema, and that
 * a real round trip still leaves every criterion unproven.
 */

const enabled =
  process.env.MERGESUTRA_LIVE_BHARATCODE === '1' &&
  Boolean(process.env.BHARATCODE_API_KEY) &&
  Boolean(process.env.BHARATCODE_MODEL);

const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

describe.skipIf(!enabled)('mergesutra plan against the real BharatCode endpoint', () => {
  it('accepts only a schema-valid plan, and never marks a criterion verified', async () => {
    const prepared = await contractBackedRun(tempDirs);
    const result = await runPlanStage(
      { runId: prepared.record.runId },
      { store: prepared.store, now: () => NOW },
    );

    if (result.plan) {
      expect(parseImplementationPlan(result.record.plan)).toEqual(result.plan);
      expect(result.record.outcome).toBe('PLAN_COMPLETE');
      expect(result.plan.provenance.model).toBe(process.env.BHARATCODE_MODEL);
    } else {
      expect(result.record.outcome).toBe('INCONCLUSIVE');
    }

    // The credential is never part of what a run keeps or prints.
    expect(JSON.stringify(result.record)).not.toContain(process.env.BHARATCODE_API_KEY ?? '—');

    expect(
      result.record.acceptanceContract?.criteria.every(
        (criterion) => criterion.status === 'PENDING',
      ),
    ).toBe(true);
    const secret = process.env.BHARATCODE_API_KEY ?? '';
    expect(JSON.stringify(result.record)).not.toContain(secret);
  }, 180_000);
});
