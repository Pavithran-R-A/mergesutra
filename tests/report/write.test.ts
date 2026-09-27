import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidencePack } from '../../src/report/pack.js';
import { writeEvidencePack } from '../../src/report/write.js';

/**
 * Where the pack goes, and what a wrong name must not be able to do to it.
 *
 * The pack is the artifact a reviewer is handed, so this file is about the two
 * things a reviewer cannot check from the page: that the three files describe
 * one run, and that nothing in a run id reaches outside its own directory.
 */

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function runsRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-pack-'));
  scratch.push(dir);
  return dir;
}

function packFor(runId: string): EvidencePack {
  return {
    runId,
    // The writer never reads this field — it decides nothing about where bytes
    // go — so a fixed digest is as good as a computed one here.
    identity: '0'.repeat(64),
    files: { 'report.md': '# pack\n', 'report.json': '{}\n', 'commands.jsonl': '' },
  };
}

describe('writing the pack', () => {
  it('puts all three files in one directory named after the run', async () => {
    const root = await runsRoot();

    const where = await writeEvidencePack(root, packFor('run-20260925T000000Z-pack001'));

    expect(path.basename(where.dir)).toBe('run-20260925T000000Z-pack001');
    expect((await readdir(where.dir)).sort()).toEqual([
      'commands.jsonl',
      'report.json',
      'report.md',
    ]);
    expect(await readFile(path.join(where.dir, 'report.md'), 'utf8')).toBe('# pack\n');
  });

  it('leaves no temporary file behind once it finishes', async () => {
    const root = await runsRoot();

    await writeEvidencePack(root, packFor('run-20260925T000000Z-pack001'));

    expect(await readdir(path.join(root, 'run-20260925T000000Z-pack001'))).toEqual(
      expect.arrayContaining(['report.md']),
    );
    const names = await readdir(path.join(root, 'run-20260925T000000Z-pack001'));
    expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces an older pack for the same run rather than adding to it', async () => {
    const root = await runsRoot();
    const dir = path.join(root, 'run-20260925T000000Z-pack001');

    await writeEvidencePack(root, packFor('run-20260925T000000Z-pack001'));
    await writeFile(path.join(dir, 'report.md'), '# stale reading of a newer record\n');
    await writeEvidencePack(root, packFor('run-20260925T000000Z-pack001'));

    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toBe('# pack\n');
  });

  it('refuses a run id that would write outside the run directory', async () => {
    const container = await mkdtemp(path.join(tmpdir(), 'mergesutra-pack-'));
    scratch.push(container);
    const root = path.join(container, 'runs');
    const neighbour = path.join(container, 'sibling-file.md');
    await writeFile(neighbour, 'a file that belongs to somebody else\n');

    await expect(writeEvidencePack(root, packFor('..'))).rejects.toThrow(/run id/i);

    expect(await readFile(neighbour, 'utf8')).toBe('a file that belongs to somebody else\n');
  });
});
