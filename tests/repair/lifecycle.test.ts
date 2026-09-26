import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlannedGate, VerificationPlan } from '../../src/verify/plan.js';
import { describePatch, stalenessOf, type PatchDescription } from '../../src/verify/patch.js';
import { runVerification } from '../../src/verify/engine.js';
import { SUCCEEDED, consentFor, planOf, steppingClock } from '../helpers/verification.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import type { Runner, RunResult } from '../../src/core/runner.js';
import {
  cleanUp,
  hasGit,
  recordWith,
  reviewFixture,
  type ReviewFixture,
} from '../helpers/review.js';

/**
 * The one rule Stage 9 cannot be allowed to break — a repair invalidates proof.
 *
 * A review that leads to an edit puts the run in a position where its own earlier
 * evidence is false: `npm test` exited 0, but on the bytes *before* the fix. Every
 * convenience in this product points at skipping the re-run — the suite takes
 * seconds, the change is one line, the reviewer already said what to do. This file
 * is why none of those excuses are available.
 *
 * It is written against the real machinery on purpose: `describePatch` reading a
 * real Git workspace, the Stage 7 engine making its own receipts, and the Stage 8
 * renderer printing what it is handed. Nothing here manufactures a receipt,
 * because a test that hand-wrote the evidence would only prove that a hand-written
 * receipt can be trusted — which is the thing under review.
 *
 * Consent is part of the same lifecycle. Stage 7 binds a human's yes to a digest of
 * the gates, so a re-planned gate set is not covered by the old yes, and a run
 * whose plan changed must reach "ask again" rather than assume permission. The
 * fixtures below inject consent deliberately and by name, exactly as the CLI would
 * after a human read it.
 */

const AVAILABLE = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

let fixture: ReviewFixture;
let patchA: PatchDescription;
let patchB: PatchDescription;

beforeAll(async () => {
  if (!AVAILABLE) return;
  fixture = await reviewFixture(made);
  patchA = fixture.patch;

  // The repair itself: one file the plan named, changed on disk. How the bytes got
  // written is Stage 6's confined writer and is tested there; what matters to this
  // lifecycle is only that they are different now.
  await writeFile(path.join(fixture.workspace, 'src/parse.ts'), 'export const REPAIRED = 7;\n');
  patchB = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
});

function scripted(results: Record<string, RunResult> = {}): {
  runner: Runner;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: Runner = async (file, args) => {
    const key = [file, ...args].join(' ');
    calls.push(key);
    return results[key] ?? SUCCEEDED;
  };
  return { runner, calls };
}

/** The same gates, planned again against the bytes the repair left behind. */
function replanned(against: PatchDescription, extra: PlannedGate[] = []): VerificationPlan {
  const original = fixture.record.verificationPlan;
  if (!original) throw new Error('the fixture must carry a verification plan');
  return planOf([...original.gates, ...extra], {
    runId: fixture.record.runId,
    baseSha: fixture.base,
    patchIdentity: against.identity,
    createdAt: '2026-09-26T10:00:00.000Z',
  });
}

describe.skipIf(!AVAILABLE)(
  'after a repair, the old verification is about a patch that is gone',
  () => {
    it('names the two measurements apart, and only says STALE once they differ', () => {
      const before = fixture.record.verification;
      if (!before) throw new Error('the fixture must carry a verification run');

      expect(stalenessOf(before.patchIdentity, patchA.identity).status).toBe('CURRENT');
      expect(stalenessOf(before.patchIdentity, patchB.identity).status).toBe('STALE');
    });

    it('refuses to let the same plan answer for the new bytes', async () => {
      const plan = fixture.record.verificationPlan;
      const consent = fixture.record.executionConsent;
      if (!plan || !consent) throw new Error('the fixture must carry a plan and a consent');
      const { runner } = scripted();

      const run = await runVerification(
        { plan, workspace: fixture.workspace, consent },
        { now: steppingClock(), runFor: () => runner },
      );

      expect(run.patchPrecondition.status).toBe('STALE');
      expect(run.result).not.toBe('PASS');
      // The receipts this run wrote name the bytes it actually saw — which are the
      // repaired ones — so the old plan cannot leave behind evidence for A.
      expect([...new Set(run.gates.map((gate) => gate.receipt.patchIdentity))]).toEqual([
        patchB.identity,
      ]);
    });

    it('makes fresh receipts for the new bytes when Stage 7 runs again', async () => {
      const plan = replanned(patchB);
      const consent = consentFor(
        plan,
        plan.gates.map((gate) => gate.id),
      );
      const { runner, calls } = scripted();

      const run = await runVerification(
        { plan, workspace: fixture.workspace, consent },
        { now: steppingClock(), runFor: () => runner },
      );

      expect(calls.length).toBe(plan.gates.length);
      expect(run.patchPrecondition.status).toBe('MATCHED');
      expect([...new Set(run.gates.map((gate) => gate.receipt.patchIdentity))]).toEqual([
        patchB.identity,
      ]);
    });

    it('never lets the pack written before the repair be read as the pack after it', () => {
      const pack = buildEvidencePack(fixture.record);

      expect(pack.files['commands.jsonl']).toContain(patchA.identity);
      expect(pack.files['commands.jsonl']).not.toContain(patchB.identity);
      expect(pack.files['report.md']).not.toContain(patchB.identity);
    });

    it('keeps a one-file repair just as disqualifying as a large one', async () => {
      const plan = fixture.record.verificationPlan;
      if (!plan) throw new Error('the fixture must carry a verification plan');
      const onlyOneLineChanged = await describePatch({
        workspace: fixture.workspace,
        baseSha: fixture.base,
      });

      expect(onlyOneLineChanged.files.length).toBe(patchB.files.length);
      expect(stalenessOf(plan.patchIdentity, onlyOneLineChanged.identity).status).toBe('STALE');
    });
  },
);

describe.skipIf(!AVAILABLE)('consent after a repair', () => {
  it('reuses the human’s yes while the gates they read are the gates that run', () => {
    const plan = fixture.record.verificationPlan;
    const consent = fixture.record.executionConsent;
    if (!plan || !consent) throw new Error('the fixture must carry a plan and a consent');

    const sameGates = replanned(patchB);

    expect(sameGates.gates.map((gate) => gate.argv)).toEqual(plan.gates.map((g) => g.argv));
    expect(consent.planDigest).not.toBe('');
    // The digest covers the commands, so re-planning against new bytes with the
    // same commands keeps a consent that was given for exactly those commands.
    expect(
      consentFor(
        sameGates,
        sameGates.gates.map((gate) => gate.id),
      ).planDigest,
    ).toBe(consent.planDigest);
  });

  it('will not borrow that yes for a gate nobody agreed to', async () => {
    const plan = fixture.record.verificationPlan;
    const consent = fixture.record.executionConsent;
    if (!plan || !consent) throw new Error('the fixture must carry a plan and a consent');
    const grown = replanned(patchB, [
      {
        ...plan.gates[0]!,
        id: 'VG-002',
      },
    ]);
    const { runner } = scripted();

    const run = await runVerification(
      { plan: grown, workspace: fixture.workspace, consent },
      { now: steppingClock(), runFor: () => runner },
    );

    const unagreed = run.gates.find((gate) => gate.gateId === 'VG-002');
    expect(unagreed?.status).toBe('BLOCKED');
    expect(unagreed?.code ?? '').toBe('BLOCKED_REPO_EXECUTION_CONSENT_STALE');
    expect(run.result).not.toBe('PASS');
  });

  it('records the block without writing a consent of its own', async () => {
    const plan = fixture.record.verificationPlan;
    const consent = fixture.record.executionConsent;
    if (!plan || !consent) throw new Error('the fixture must carry a plan and a consent');
    const grown = replanned(patchB, [{ ...plan.gates[0]!, id: 'VG-002' }]);
    const { runner } = scripted();

    const run = await runVerification(
      { plan: grown, workspace: fixture.workspace, consent },
      { now: steppingClock(), runFor: () => runner },
    );
    const afterRepair = recordWith(fixture.record, {
      verificationPlan: grown,
      verification: run,
    });

    expect(afterRepair.executionConsent).toEqual(consent);
    expect(afterRepair.executionConsent?.planDigest).toBe(consent.planDigest);
    expect(JSON.stringify(afterRepair).includes('grantedAt')).toBe(true);
    expect(afterRepair.verification?.result).not.toBe('PASS');
  });
});
