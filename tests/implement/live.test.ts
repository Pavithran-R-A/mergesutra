import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRunner } from '../../src/core/runner.js';
import { runContractStage } from '../../src/cli/contract.js';
import { runInspect } from '../../src/discovery/inspect.js';
import { runPlanStage } from '../../src/plan/plan.js';
import { runImplementStage } from '../../src/implement/implement.js';
import { hasGit, realRepository } from '../helpers/git.js';
import { memoryRunStore, type MemoryRunStore } from '../helpers/github.js';
import { planBodyFor, scriptedClient } from '../helpers/bharatcode.js';
import { cleanUp, NOW } from '../helpers/plan.js';

/**
 * The only Stage 6 test allowed to spend a real model call, and it stays silent
 * unless it is explicitly invited:
 *
 * ```
 * MERGESUTRA_LIVE_BHARATCODE=1 BHARATCODE_API_KEY=… BHARATCODE_MODEL=… npm run test:live
 * ```
 *
 * Everything else in the suite runs against a scripted client, because a test
 * that depends on a model's mood is not a test. So this one asks only structural
 * questions — the ones that stay true whatever the model decided to write: the
 * run records the model it actually spoke to, the Acceptance Contract comes back
 * unchanged with every criterion still `PENDING`, nothing is called
 * `CONTRIBUTION_READY`, and the credential appears nowhere in what the run keeps.
 *
 * The loop is deliberately bounded to three turns: one genuine round trip is the
 * claim, and paying for twelve of them is not.
 */

const enabled =
  process.env.MERGESUTRA_LIVE_BHARATCODE === '1' &&
  Boolean(process.env.BHARATCODE_API_KEY) &&
  Boolean(process.env.BHARATCODE_MODEL);

const gitAvailable = await hasGit();
const tempDirs: string[] = [];

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

/**
 * The contract as the plan stage left it, serialised.
 *
 * Captured before the loop runs and compared after, so "the Acceptance Contract
 * was not modified" is checked against this run's own earlier record instead of
 * against a hand-written expectation of what a contract looks like.
 */
interface LiveFixture {
  readonly repo: string;
  readonly store: MemoryRunStore;
  readonly runId: string;
  readonly contractBefore: string;
}

/** Stage 1 → 4 for real, so the live loop consumes what the product actually makes. */
async function plannedRunInRepo(): Promise<LiveFixture> {
  const repo = await realRepository();
  tempDirs.push(repo);
  const store = memoryRunStore();
  const inspected = await runInspect({ repoPath: repo }, { run: defaultRunner, store });
  const contracted = await runContractStage(
    { runId: inspected.record.runId },
    { store, now: () => NOW },
  );
  const criteria = contracted.acceptanceContract?.criteria.map((entry) => entry.id) ?? [];
  if (criteria.length === 0) throw new Error('fixture repository declared no gates');
  const planned = await runPlanStage(
    { runId: contracted.record.runId },
    { store, now: () => NOW, random: () => 0.5, client: scriptedClient([planBodyFor(criteria)]) },
  );
  if (!planned.record.acceptanceContract) throw new Error('fixture lost its contract');
  if (!planned.record.plan) throw new Error('fixture produced no plan');
  return {
    repo,
    store,
    runId: planned.record.runId,
    contractBefore: JSON.stringify(planned.record.acceptanceContract),
  };
}

describe.skipIf(!enabled || !gitAvailable)(
  'mergesutra implement against the real BharatCode endpoint',
  () => {
    it('spends one bounded loop, keeps the contract untouched, and never keeps the key', async () => {
      const fixture = await plannedRunInRepo();
      const model = process.env.BHARATCODE_MODEL ?? '';
      const secret = process.env.BHARATCODE_API_KEY ?? '';

      // No `client` and no `run`: this is the real endpoint in a real worktree.
      const result = await runImplementStage(
        { runId: fixture.runId, model, limits: { maxSteps: 3 } },
        { store: fixture.store, now: () => NOW, cwd: fixture.repo },
      );

      // A workspace was really made, at the run's base, inside the repository.
      expect(result.workspace.path).toContain(path.join('.mergesutra', 'worktrees'));
      expect(existsSync(result.workspace.path)).toBe(true);
      expect(result.implementation.workspace.baseSha).toBe(result.workspace.baseSha);

      // Whatever the model did, the run names the model it spoke to.
      if (result.implementation.summary.modelRequests > 0) {
        expect(result.implementation.model).toBeTruthy();
      }

      // The boundary this stage must never cross: claims are recorded, verdicts are not.
      expect(result.implementation.contractUntouched).toBe(true);
      expect(result.implementation.verified).toBe(false);
      expect(result.implementation.untrusted).toBe(true);
      expect(JSON.stringify(result.record.acceptanceContract)).toBe(fixture.contractBefore);
      expect(result.record.acceptanceContract?.criteria.every((c) => c.status === 'PENDING')).toBe(
        true,
      );
      expect(JSON.stringify(result.record)).not.toContain('CONTRIBUTION_READY');
      expect(result.checks.find((check) => check.name === 'Verification')?.status).toBe(
        'NOT_AVAILABLE',
      );

      // The credential is never part of what a run keeps.
      expect(JSON.stringify(result.record)).not.toContain(secret);
      expect(JSON.stringify(result.implementation)).not.toContain(secret);
    }, 300_000);
  },
);
