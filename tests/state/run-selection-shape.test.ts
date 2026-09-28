import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { code, importsSpecifier } from '../helpers/sourceShape.js';

/**
 * Nobody gets to hold a second opinion about which run an omitted id means.
 *
 * S12-06 was not eight independent bugs: it was one rule — "take the newest
 * readable record" — written eight times, each copy free to be as careful as its
 * author felt. The fix is a shared selection, and a shared selection only holds
 * while nobody re-derives it. A behavioural suite cannot protect that: as the
 * mutation run recorded, putting a private walk back into `src/repair/stage.ts`
 * leaves every existing test green, because no fixture places an unreadable record
 * in a walker's directory. So the check is over the source itself.
 *
 * Two claims, each with a named list so a guard cannot quietly shrink:
 *
 * 1. only `state/run-selection.ts` sorts records by age and takes the first — no
 *    other module reads `runs[0]` or walks the readable list looking for one;
 * 2. every module that resolves an omitted run id goes through that selection,
 *    by importing it.
 *
 * Both are read as data, comments stripped: a refusal *explained* in prose is not
 * a second implementation, and a comment that quotes the old bug must not trip
 * the guard written to keep it fixed.
 */

const SRC = path.join(process.cwd(), 'src');

/** The modules that answer an omitted run id, and may not answer it themselves. */
const SELECTION_SITES = [
  'cli/contract.ts',
  'cli/report.ts',
  'implement/implement.ts',
  'lifecycle/status.ts',
  'plan/plan.ts',
  'repair/stage.ts',
  'review/stage.ts',
  'verify/stage.ts',
];

/** The one module allowed to order records and pick from that order. */
const SELECTION_OWNER = 'state/run-selection.ts';

/** How a module asks for the run an omitted id would mean. */
const OMITS_ID = /\b(?:input|options)\.runId\s*\?\?/;

/** The private selections S12-06 removed, spelled the way source spells them. */
const REIMPLEMENTS = [/\bruns\[0\]/, /for \(const summary of runs\)/];

async function sources(): Promise<Map<string, string>> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.name.endsWith('.ts')) files.push(next);
    }
  };
  await walk(SRC);
  const texts = await Promise.all(
    files.map(
      async (file) =>
        [path.relative(SRC, file).replace(/\\/g, '/'), code(await readFile(file, 'utf8'))] as const,
    ),
  );
  return new Map(texts);
}

describe('who may decide which run an omitted run id means', () => {
  it('is one module, and no module reads a newest record on its own', async () => {
    const found = [...(await sources())]
      .filter(
        ([file, text]) =>
          file !== SELECTION_OWNER && REIMPLEMENTS.some((shape) => shape.test(text)),
      )
      .map(([file]) => file);

    expect(found).toEqual([]);
  });

  it('is reached through the shared selection from every command that omits an id', async () => {
    const all = await sources();
    const asking = [...all]
      .filter(([, text]) => OMITS_ID.test(text))
      .map(([file]) => file)
      .sort();

    // The list is named, so a call site that stopped importing the shared rule
    // shows up as a missing entry rather than as a guard that no longer looks.
    expect(asking).toEqual(SELECTION_SITES);
    for (const file of asking) {
      expect(importsSpecifier(all.get(file) ?? '', 'state/run-selection.js')).toBe(true);
    }
  });
});
