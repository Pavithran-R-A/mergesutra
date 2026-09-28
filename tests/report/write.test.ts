import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePack } from '../../src/report/pack.js';
import type { EvidencePack } from '../../src/report/pack.js';
import { readPackFacts, readPackIdentity, writeEvidencePack } from '../../src/report/write.js';
import { sha256Hex } from '../../src/security/digest.js';
import { PACK_RUN_ID, recordAt, verifiedRecord } from '../helpers/report.js';

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

/**
 * The other half of a pack reading: which patch its own bytes claim to describe.
 *
 * Stage 10 used to answer that question from the run record sitting beside the pack,
 * which meant a directory holding the pack rendered for patch A could be reported as
 * describing patch B — the record was asked, and the record answered. So the claim
 * has to come out of `report.json`, and every way of not finding one there is a `null`
 * that the caller refuses rather than a value invented to keep a page moving.
 */
describe('reading the patch claim a pack makes about itself', () => {
  async function packOnDisk(pack: EvidencePack): Promise<string> {
    const root = await runsRoot();
    await writeEvidencePack(root, pack);
    return root;
  }

  it('names the patch the rendered page prints, from the pack', async () => {
    const record = await verifiedRecord(['npm', 'test']);
    const root = await packOnDisk(buildEvidencePack(record));

    const facts = await readPackFacts(root, PACK_RUN_ID);

    expect(facts?.patchClaim).toBe(record.verificationPlan?.patchIdentity);
    expect(facts?.identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it('follows the bytes, not the run that happens to be filed beside them', async () => {
    const root = await packOnDisk(buildEvidencePack(await verifiedRecord(['npm', 'test'])));
    const target = path.join(root, PACK_RUN_ID, 'report.json');
    const claimed = sha256Hex('a patch this pack was rendered for');

    await writeFile(target, `${JSON.stringify({ patch: { plannedIdentity: claimed } })}\n`, 'utf8');

    expect((await readPackFacts(root, PACK_RUN_ID))?.patchClaim).toBe(claimed);
  });

  it('reads no claim from a report.json that is not JSON', async () => {
    const root = await packOnDisk(buildEvidencePack(await verifiedRecord(['npm', 'test'])));

    await writeFile(path.join(root, PACK_RUN_ID, 'report.json'), '{"patch": {"plannedIdentity":');

    const facts = await readPackFacts(root, PACK_RUN_ID);
    expect(facts?.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(facts?.patchClaim).toBeNull();
  });

  it('reads no claim from a pack that says it describes no patch', async () => {
    // A run that never planned a patch really does render `plannedIdentity: null`, so
    // the null has to survive the read instead of being filled in from anywhere else.
    const root = await packOnDisk(buildEvidencePack(recordAt()));

    expect((await readPackFacts(root, PACK_RUN_ID))?.patchClaim).toBeNull();
  });

  it('refuses a claim that arrives through a prototype instead of the document', async () => {
    const root = await packOnDisk(buildEvidencePack(await verifiedRecord(['npm', 'test'])));

    // `patch` is not a key of this file; it hangs off `__proto__`, where a plain
    // `parsed.patch` lookup would find it.
    await writeFile(
      path.join(root, PACK_RUN_ID, 'report.json'),
      `{"__proto__": {"patch": {"plannedIdentity": ${JSON.stringify(sha256Hex('inherited'))}}}}`,
      'utf8',
    );

    expect((await readPackFacts(root, PACK_RUN_ID))?.patchClaim).toBeNull();
  });

  it('reads no claim from a plannedIdentity that is not a digest', async () => {
    const root = await packOnDisk(buildEvidencePack(await verifiedRecord(['npm', 'test'])));

    await writeFile(
      path.join(root, PACK_RUN_ID, 'report.json'),
      JSON.stringify({ patch: { plannedIdentity: { toString: () => 'a'.repeat(64) } } }),
      'utf8',
    );

    expect((await readPackFacts(root, PACK_RUN_ID))?.patchClaim).toBeNull();
  });

  it('reads no claim from a plannedIdentity that is not shaped like a patch identity', async () => {
    // A readiness row prints the head of this value, so a string that is not a digest
    // would reach the terminal as characters somebody else chose, escape sequences
    // included. Only the shape the renderer itself writes counts as a claim.
    const root = await packOnDisk(buildEvidencePack(await verifiedRecord(['npm', 'test'])));
    const hostile = `${String.fromCharCode(27)}[31mcleared screen`;

    await writeFile(
      path.join(root, PACK_RUN_ID, 'report.json'),
      JSON.stringify({ patch: { plannedIdentity: hostile } }),
      'utf8',
    );

    expect((await readPackFacts(root, PACK_RUN_ID))?.patchClaim).toBeNull();
  });
});
