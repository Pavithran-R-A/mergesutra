import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
 * The identity of the pack a run's directory actually holds, or `null`.
 *
 * A stage that binds a human's decision to the evidence has to name the files
 * they can open, and re-rendering from the current record would not do that: the
 * record moves whenever a later stage files its own outcome, so the identity would
 * move with it and an approval would expire because somebody wrote a status, not
 * because the evidence changed. So this reads the three files and hashes those
 * bytes, and says `null` for anything that is not a pack — a directory holding
 * two of the three is a partial reading, which is worse than none.
 *
 * An unreadable file counts as no pack for the same reason. The answer is a fact
 * about what a reviewer can go and check, and a file they cannot open is not one.
 */
export async function readPackIdentity(runsRoot: string, runId: string): Promise<string | null> {
  const dir = path.join(runsRoot, assertSafePathSegment(runId, 'run id'));
  const files = {} as Record<PackFileName, string>;
  for (const name of PACK_FILE_NAMES) {
    try {
      files[name] = await readFile(path.join(dir, name), 'utf8');
    } catch {
      return null;
    }
  }
  return packIdentityOf(files);
}
