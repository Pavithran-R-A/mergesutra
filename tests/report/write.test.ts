import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../../src/report/pack.js';
import type { EvidencePack } from '../../src/report/pack.js';
import { readPackIdentity, writeEvidencePack } from '../../src/report/write.js';
import { PACK_RUN_ID, recordAt } from '../helpers/report.js';

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

/**
 * Reading a pack's identity back off disk.
 *
 * Stage 10 binds a human's yes to the evidence pack, which means it has to name
 * the pack somebody can actually open — not a pack re-rendered from the current
 * record, since a later stage filing its own outcome would otherwise silently
 * expire an approval nobody revisited. So the answer comes from the three files,
 * and the two cases that are not answers are said as `null` rather than guessed:
 * a run with no pack, and a run whose pack is missing one of its three files.
 */
describe('reading the identity of the pack that is on disk', () => {
  it('names the pack a renderer wrote, from the bytes on disk', async () => {
    const root = await runsRoot();
    const pack = buildEvidencePack(recordAt());

    const where = await writeEvidencePack(root, pack);

    expect(await readPackIdentity(root, PACK_RUN_ID)).toBe(pack.identity);
    expect(where.dir).toBe(path.join(root, PACK_RUN_ID));
  });

  it('follows the bytes: a rewritten file is a different pack', async () => {
    const root = await runsRoot();
    const pack = buildEvidencePack(recordAt());
    await writeEvidencePack(root, pack);
    const before = await readPackIdentity(root, PACK_RUN_ID);

    const target = path.join(root, PACK_RUN_ID, 'report.md');
    await writeFile(target, `${await readFile(target, 'utf8')}\nan added line\n`);

    const after = await readPackIdentity(root, PACK_RUN_ID);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect(await readPackIdentity(root, PACK_RUN_ID)).toBe(after);
  });

  it('says there is no pack rather than naming a partial one', async () => {
    const root = await runsRoot();
    await writeEvidencePack(root, packFor(PACK_RUN_ID));
    await rm(path.join(root, PACK_RUN_ID, 'commands.jsonl'));

    expect(await readPackIdentity(root, PACK_RUN_ID)).toBeNull();
    expect(await readPackIdentity(root, 'run-without-a-pack')).toBeNull();
  });

  it('refuses a run id that would read outside the run directory', async () => {
    const container = await mkdtemp(path.join(tmpdir(), 'mergesutra-pack-'));
    scratch.push(container);
    const root = path.join(container, 'runs');
    await writeEvidencePack(root, packFor('someone-else'));

    await expect(readPackIdentity(root, '..')).rejects.toThrow(/run id/i);
  });
});
