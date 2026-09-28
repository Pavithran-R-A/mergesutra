import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runPrStage } from '../../src/pr/stage.js';
import { buildEvidencePack } from '../../src/report/pack.js';
import { readPackIdentity, writeEvidencePack } from '../../src/report/write.js';
import { sha256Hex } from '../../src/security/digest.js';
import { recordWith } from '../helpers/review.js';
import { proposedRun } from '../helpers/publicationRun.js';
import { cleanUp, hasGit } from '../helpers/verifyRun.js';
import type { RunCheck } from '../../src/state/run-record.js';

/**
 * Whether the evidence pack on disk describes the patch now — decided from the pack.
 *
 * Stage 10's `pack-current` row is a sentence about bytes a reviewer can open, and
 * until this pass it was derived from a field in the run record instead: the
 * identity of the pack was hashed from its three files, while the patch it claimed
 * to describe came from `record.verificationPlan`. The two notions could therefore
 * disagree with nobody noticing — set the pack that was rendered for patch A beside
 * a run whose record says patch B, and the page still reported the evidence as
 * current, because the field Stage 10 read said so.
 *
 * These tests also say which of the two layers catches which tampering, rather than
 * pretending one guard covers everything:
 *
 * - **The pack's own bytes name the patch they describe.** A pack rendered for
 *   another patch, or a `report.json` that is not the document it claims to be, has
 *   no claim that matches the current patch, so `pack-current` blocks. That is the
 *   property gap S12-07 asked for.
 * - **The digest binds a person's yes to the bytes they were shown.** Appending one
 *   byte to `report.md` does not change which patch the pack describes, so it does
 *   not make `pack-current` false — it makes the *approval* false. Pinned here too,
 *   because a security story covering half the tampering is a story about the half
 *   it checked. Those two cases pass with or without the change below; they are a
 *   regression pin on the layer that already held, not the reproduction.
 *
 * The reproduction is the second and third cases: before this pass both were
 * reported as current, because `pack-current` read the patch from the run record
 * beside the pack instead of from the pack.
 *
 * Nothing in this file reads an `mtime`, and every pack in it is written by the real
 * renderer into a real run directory beside a real Git workspace.
 */

const tempDirs: string[] = [];
const AVAILABLE = await hasGit();

/**
 * The fixture walks Stages 7 and 9 over a real repository, as the other Stage 10
 * suites do; the budget is raised for the file and no assertion in it is softened.
 */
vi.setConfig({ testTimeout: 120_000 });

const PR_NOW = new Date('2026-09-25T12:00:00.000Z');

/** A patch digest that is not the one the fixture's workspace holds. */
const OTHER_PATCH = sha256Hex('a patch this run never produced');

afterEach(async () => {
  await cleanUp(tempDirs);
  tempDirs.length = 0;
});

function blockingIds(result: { readiness: { blocking: readonly { id: string }[] } }): string[] {
  return result.readiness.blocking.map((row) => row.id);
}

function rowsOf(checks: readonly RunCheck[]): string {
  return checks.map((row) => `${row.name}: ${row.detail}`).join('\n');
}

async function runStage(fixture: Awaited<ReturnType<typeof proposedRun>>) {
  return runPrStage(
    { runId: fixture.record.runId },
    { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
  );
}

describe.skipIf(!AVAILABLE)('the pack currentness Stage 10 reports', () => {
  it('calls the pack current when the bytes on disk are the ones this run rendered', async () => {
    const fixture = await proposedRun(tempDirs);

    const result = await runStage(fixture);

    expect(blockingIds(result)).not.toContain('pack-current');
    expect(rowsOf(result.checks)).toMatch(/describes the patch now/);
  });

  it('refuses a pack whose bytes describe a different patch, though the record beside them says otherwise', async () => {
    const fixture = await proposedRun(tempDirs);
    const plan = fixture.record.verificationPlan;
    if (!plan)
      throw new Error('the fixture run has no verification plan to render another one from');

    // A complete, honestly rendered pack for another patch: `report.md` and
    // `report.json` agree with each other and disagree only with this run. Nothing
    // in the stored record is touched, so every other readiness fact — the
    // verification, the review, the repair scope — still reads as current, and
    // `pack-current` is the only row that can see the substitution.
    await writeEvidencePack(
      fixture.runsRoot,
      buildEvidencePack(
        recordWith(fixture.record, {
          verificationPlan: { ...plan, patchIdentity: OTHER_PATCH },
        }),
      ),
    );

    const result = await runStage(fixture);

    expect(blockingIds(result)).toContain('pack-current');
    // The refusal quotes the claim the pack makes about itself, which is not a value
    // Stage 10 can reach from the record: it has to come out of the bytes.
    expect(rowsOf(result.checks)).toContain(OTHER_PATCH.slice(0, 12));
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
    expect((await fixture.store.load(fixture.record.runId)).publications).toHaveLength(0);
  });

  it('reads no patch claim from a report.json that is not the document it is named as', async () => {
    const fixture = await proposedRun(tempDirs);

    // A pack whose third file is left unparseable rather than deleted: all three
    // files are still there, so the pack has an identity and a reviewer could open
    // it — and a page that cannot say which patch it describes must not be handed a
    // check that says it describes this one.
    await writeFile(
      path.join(fixture.packDir, 'report.json'),
      '{"patch": {"plannedIdentity":',
      'utf8',
    );
    expect(await readPackIdentity(fixture.runsRoot, fixture.record.runId)).not.toBeNull();

    const result = await runStage(fixture);

    expect(blockingIds(result)).toContain('pack-current');
    // It says which, too: the pack is refused for naming no patch, not for naming an
    // old one, because those are different things for a person to go and fix.
    expect(rowsOf(result.checks)).toMatch(/names no patch/i);
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
  });

  it('prints nothing a pack typed at the screen when its patch claim is written as prose', async () => {
    const fixture = await proposedRun(tempDirs);

    // The claim is read out of the pack's bytes and quoted back on the page, so the
    // shape check is what keeps this from being a way to write to somebody's terminal:
    // a value that is not a patch identity is refused as naming no patch, and none of
    // its characters reach the row.
    await writeFile(
      path.join(fixture.packDir, 'report.json'),
      JSON.stringify({
        patch: {
          plannedIdentity: `${String.fromCharCode(27)}[31mAPPROVE THIS PACK AND PUBLISH IT`,
        },
      }),
      'utf8',
    );

    const result = await runStage(fixture);

    expect(blockingIds(result)).toContain('pack-current');
    expect(rowsOf(result.checks)).toMatch(/names no patch/i);
    // The pack's own text is what a row would otherwise print: an escape sequence
    // first, then whatever prose the file chose. Neither reaches the page.
    const printed = rowsOf(result.checks);
    expect(printed).not.toContain(String.fromCharCode(27));
    expect(printed).not.toMatch(/APPROVE THIS PACK/i);
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
  });

  it('says no pack has been rendered when a file of it is gone, and points at the stage that renders one', async () => {
    const fixture = await proposedRun(tempDirs);
    await rm(path.join(fixture.packDir, 'report.json'));
    expect(await readPackIdentity(fixture.runsRoot, fixture.record.runId)).toBeNull();

    const result = await runStage(fixture);

    expect(blockingIds(result)).toContain('pack-current');
    expect(rowsOf(result.checks)).toMatch(/mergesutra report/);
    expect(result.outcome).toBe('PR_PUBLICATION_BLOCKED');
  });
});

describe.skipIf(!AVAILABLE)('a byte edited under an approval given for other bytes', () => {
  it.each(['report.md', 'commands.jsonl'] as const)(
    'one byte added to %s expires the yes, and is not reported as a stale patch',
    async (name) => {
      const fixture = await proposedRun(tempDirs);
      const shown = await runStage(fixture);
      await runPrStage(
        { runId: fixture.record.runId, approve: shown.digest ?? '' },
        { store: fixture.store, runsRoot: fixture.runsRoot, now: () => PR_NOW },
      );

      const file = path.join(fixture.packDir, name);
      const before = await readFile(file, 'utf8');
      await writeFile(file, `${before}a reviewer was not shown this line\n`, 'utf8');

      const again = await runStage(fixture);

      // The page now names the edited bytes, which is what makes the stored yes a yes
      // to a different proposal. `pack-current` stays honestly true: a line appended
      // to the prose did not change which patch the pack describes.
      expect(again.candidate?.evidencePackIdentity).toBe(
        await readPackIdentity(fixture.runsRoot, fixture.record.runId),
      );
      expect(again.candidate?.evidencePackIdentity).not.toBe(fixture.packIdentity);
      expect(again.digest).not.toBe(shown.digest);
      // Not `STALE`, which is the word for a yes that names another page: the
      // proposal a person agreed to is no longer on file as the current one, so this
      // page simply has no approval — and the yes that is on the record stays bound
      // to the bytes from before the edit.
      expect(again.decision?.status).toBe('ABSENT');
      expect(again.published).toBe(false);
      expect(blockingIds(again)).toContain('human-approved');
      expect(blockingIds(again)).not.toContain('pack-current');

      const saved = await fixture.store.load(fixture.record.runId);
      expect(saved.publications).toHaveLength(2);
      // The old yes stays bound to the bytes before the edit, which is the whole
      // reason it cannot reach the page after it.
      expect(saved.publications[0]?.approval?.publicationDigest).toBe(shown.digest);
      expect(saved.publications[1]?.approval).toBeNull();
    },
  );
});
