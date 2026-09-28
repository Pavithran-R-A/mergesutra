import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { assertSafePathSegment } from '../security/path-safety.js';
import { PACK_FILE_NAMES, packIdentityOf, type EvidencePack, type PackFileName } from './pack.js';

/**
 * The pack is the artifact a reviewer is handed, so these are the two things a
 * reader cannot check from the page: that the three files describe one run, and
 * that nothing in a run id reaches outside that run's own directory.
 *
 * Each file goes in by temp-then-rename, and an existing directory is replaced
 * rather than appended to — a pack left over from an earlier reading of the
 * record is worse than no pack, because it looks like the current one.
 */
export interface PackLocation {
  readonly dir: string;
  readonly files: Readonly<Record<(typeof PACK_FILE_NAMES)[number], string>>;
}

export async function writeEvidencePack(
  runsRoot: string,
  pack: EvidencePack,
): Promise<PackLocation> {
  const runId = assertSafePathSegment(pack.runId, 'run id');
  const dir = path.join(runsRoot, runId);
  await mkdir(dir, { recursive: true });

  const files = {} as Record<(typeof PACK_FILE_NAMES)[number], string>;
  for (const name of PACK_FILE_NAMES) {
    const target = path.join(dir, name);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, pack.files[name], { mode: 0o600 });
    await rename(temp, target);
    files[name] = target;
  }
  return { dir, files };
}

/**
 * The two facts a run's pack directory can be asked for, or `null` for none.
 *
 * A stage that binds a human's decision to the evidence has to name the files
 * they can open, and re-rendering from the current record would not do that: the
 * record moves whenever a later stage files its own outcome, so the identity would
 * move with it and an approval would expire because somebody wrote a status, not
 * because the evidence changed. So both halves below come from reading the three
 * files, and `null` is returned for anything that is not a pack — a directory
 * holding two of the three is a partial reading, which is worse than none.
 *
 * An unreadable file counts as no pack for the same reason. The answer is a fact
 * about what a reviewer can go and check, and a file they cannot open is not one.
 */
export interface PackFacts {
  /** The digest over the three files as they now are: which pack a person was shown. */
  readonly identity: string;
  /**
   * The patch those bytes claim to describe, as `report.md` prints it — read from the
   * pack rather than from the record, because the two can be made to disagree.
   */
  readonly patchClaim: string | null;
}

/** The identity half of `readPackFacts`, for a reader that only needs to name the pack. */
export async function readPackIdentity(runsRoot: string, runId: string): Promise<string | null> {
  return (await readPackFacts(runsRoot, runId))?.identity ?? null;
}

/**
 * What the bytes in a run's pack say about themselves.
 *
 * `identity` is the digest over the three files, so it answers *which* pack a person
 * was shown. `patchClaim` answers what that pack asserts about the code — the patch
 * `report.md` prints on its `Patch:` line, which is the same value `report.json`
 * carries under `patch.plannedIdentity`, and is read here from those bytes rather
 * than from the run record sitting beside them. The difference matters exactly once:
 * a directory can hold a pack that was rendered for a different patch, and a stage
 * that asked the record what the pack said would hear the record.
 *
 * `null` for a claim the file does not carry, including a `report.json` that is not
 * JSON at all. That is a refusal rather than a guess: a page that cannot name its
 * patch cannot be called current for this one.
 */
export async function readPackFacts(runsRoot: string, runId: string): Promise<PackFacts | null> {
  const dir = path.join(runsRoot, assertSafePathSegment(runId, 'run id'));
  const files = {} as Record<PackFileName, string>;
  for (const name of PACK_FILE_NAMES) {
    try {
      files[name] = await readFile(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  }
  return { identity: packIdentityOf(files), patchClaim: patchClaimOf(files['report.json']) };
}

/**
 * Only the field a later stage may read as a claim; everything else stays unrendered here.
 *
 * The claim has to look like the patch identity the renderer writes. A looser view would
 * hand a readiness row an arbitrary string from the file to print in front of a person,
 * and a string that is not a digest identifies nothing whatever.
 */
const packClaimSchema = z
  .object({
    patch: z
      .object({
        plannedIdentity: z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .nullable(),
      })
      .passthrough(),
  })
  .passthrough();

function patchClaimOf(reportJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reportJson);
  } catch {
    return null;
  }
  const result = packClaimSchema.safeParse(parsed);
  return result.success ? result.data.patch.plannedIdentity : null;
}
