import { afterAll, describe, expect, it } from 'vitest';
import { runReviewStage } from '../../src/review/stage.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { describePatch } from '../../src/verify/patch.js';
import { memoryRunStore } from '../helpers/github.js';
import { hasGit } from '../helpers/git.js';
import { cleanUp, NOW } from '../helpers/plan.js';
import { reviewFixture } from '../helpers/review.js';

/**
 * The one Stage 9 test allowed to spend a real model call, and it stays silent
 * unless it is invited:
 *
 * ```
 * MERGESUTRA_LIVE_BHARATCODE=1 BHARATCODE_API_KEY=… BHARATCODE_MODEL=… npm run test:live
 * ```
 *
 * Everything else about the run is the same machinery the offline suite drives:
 * a real Git workspace, a real patch, real Stage 7 receipts. Only the reviewer is
 * live, because a model's opinion is exactly as verifiable as its mood — so this
 * test asks nothing about whether the findings are *right* and everything about
 * whether the harness held: the answer was bound to the bytes it was shown, every
 * citation points at material that was actually sent, nothing in the workspace
 * moved, and the credential appears nowhere the record goes.
 *
 * A finding from a live model is still a model's finding. It gets a disposition
 * from MergeSutra and, at most, a plan that edits nothing.
 */

const enabled =
  process.env.MERGESUTRA_LIVE_BHARATCODE === '1' &&
  Boolean(process.env.BHARATCODE_API_KEY) &&
  Boolean(process.env.BHARATCODE_MODEL);

const gitAvailable = await hasGit();
const made: string[] = [];

afterAll(async () => {
  await cleanUp(made);
});

describe.skipIf(!enabled || !gitAvailable)(
  'mergesutra review against the real BharatCode endpoint',
  () => {
    it('binds a live answer to the bytes it read, and keeps the key out of what it stores', async () => {
      const fixture = await reviewFixture(made);
      const store = memoryRunStore();
      await store.save(fixture.record);
      const secret = process.env.BHARATCODE_API_KEY ?? '';
      if (!secret)
        throw new Error('the live run is enabled without a key to keep out of the record');

      const before = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });
      // No `client`: this is the shipped product, reading its own credential from
      // the environment the way an operator would set it.
      const result = await runReviewStage(
        { runId: fixture.record.runId },
        { store, now: () => NOW },
      );
      const after = await describePatch({ workspace: fixture.workspace, baseSha: fixture.base });

      // Reviewing is a reading. The workspace it started with is the workspace it left.
      expect(after.identity).toBe(before.identity);

      if (result.review) {
        // Whatever it said, the record names the model that said it and the diff it
        // was read against — the two things a later stage needs to trust the answer.
        expect(result.review.modelId.length).toBeGreaterThan(0);
        expect(result.review.reviewedPatchIdentity).toBe(before.identity);
        expect(result.attempt.patchPrecondition).toBe('MATCHED');

        const sent = new Set(result.context.manifest.references.map((reference) => reference.ref));
        for (const finding of result.review.findings) {
          // A live model that cites real material still has to cite it; nothing about
          // the endpoint relaxes the check the offline tests enforce.
          expect(finding.contextRefs.length).toBeGreaterThan(0);
          for (const ref of finding.contextRefs) expect(sent.has(ref)).toBe(true);
          // Its authority is a routing label MergeSutra gave it, nothing more.
          expect(typeof finding.dispositionReason).toBe('string');
        }

        // Its verdict vocabulary is MergeSutra's, and it has no word for ready.
        expect(result.record.outcome).toMatch(/^REVIEW_/);
        expect(JSON.stringify(result.record)).not.toContain('CONTRIBUTION_READY');
      } else {
        // A refusal is allowed and is recorded as one — never as silence that reads
        // as a clean bill.
        expect(['REFUSED', 'MODEL_UNAVAILABLE', 'STALE', 'CANCELLED']).toContain(
          result.attempt.status,
        );
        expect(result.record.outcome).toMatch(/^REVIEW_/);
      }

      // The contract is not the reviewer's to move.
      expect(JSON.stringify(result.record.acceptanceContract)).toBe(
        JSON.stringify(fixture.record.acceptanceContract),
      );

      // Nothing the run keeps, renders or writes carries the credential.
      const pack = buildEvidencePack(result.record);
      for (const text of [JSON.stringify(result.record), ...Object.values(pack.files)]) {
        expect(text).not.toContain(secret);
      }
    }, 300_000);
  },
);
