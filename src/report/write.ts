import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafePathSegment } from '../security/path-safety.js';
import { PACK_FILE_NAMES, type EvidencePack } from './pack.js';

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
