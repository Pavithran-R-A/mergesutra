import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { run } from '../../src/cli/program.js';
import { EXIT } from '../../src/cli/exit-codes.js';
import { defaultRunStoreRoot } from '../../src/state/run-store.js';
import { memoryRunStore } from '../helpers/github.js';
import { recordAt, verifiedRecord } from '../helpers/report.js';

/**
 * `mergesutra report` — the pack as a command.
 *
 * The builder decides nothing and the writer puts bytes down; what is left for
 * this file is the part a reviewer actually experiences: that the page they read
 * is the pack on disk, that a run which never verified cannot be rendered as one
 * that did, and that asking for a run nobody recorded fails loudly instead of
 * producing an empty report.
 */

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    write: (line: string) => out.push(line),
    writeErr: (line: string) => err.push(line),
    text: () => out.join('\n'),
    errorText: () => err.join('\n'),
  };
}

async function cwdOf(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mergesutra-report-'));
  scratch.push(dir);
  return dir;
}

describe('mergesutra report', () => {
  it('prints the pack and writes the same pack it printed', async () => {
    const cwd = await cwdOf();
    const record = await verifiedRecord(['node', '--test']);
    const store = memoryRunStore();
    await store.save(record);
    const c = capture();

    const code = await run(['node', 'mergesutra', 'report', record.runId], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      report: { store, cwd },
    });

    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('VG-001');
    expect(c.text()).toContain('AC-1');
    const dir = path.join(defaultRunStoreRoot(cwd), record.runId);
    expect((await readdir(dir)).sort()).toEqual(['commands.jsonl', 'report.json', 'report.md']);
    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toContain('exit 0');
  });

  it('says so when the run it was given has not been verified', async () => {
    const cwd = await cwdOf();
    const record = recordAt();
    const store = memoryRunStore();
    await store.save(record);
    const c = capture();

    const code = await run(['node', 'mergesutra', 'report', record.runId], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      report: { store, cwd },
    });

    expect(code).toBe(EXIT.OK);
    expect(c.text()).toContain('PENDING');
    expect(c.text()).toMatch(/no gate has run/i);
    expect(c.text()).not.toMatch(/VERIFIED/);
  });

  it('keeps --json the pack, not a story about the pack', async () => {
    const cwd = await cwdOf();
    const record = await verifiedRecord(['node', '--test']);
    const store = memoryRunStore();
    await store.save(record);
    const c = capture();

    await run(['node', 'mergesutra', '--json', 'report', record.runId], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      report: { store, cwd },
    });

    const json = JSON.parse(c.text()) as {
      runId: string;
      contributionReady: boolean;
      criteria: readonly { status: string; sufficiency: string }[];
    };
    expect(json.runId).toBe(record.runId);
    expect(json.contributionReady).toBe(false);
    expect(json.criteria).toHaveLength(1);
    expect(json.criteria[0]).toMatchObject({ status: 'PASS', sufficiency: 'VERIFIED' });
    const onDisk = JSON.parse(
      await readFile(path.join(defaultRunStoreRoot(cwd), record.runId, 'report.json'), 'utf8'),
    );
    expect(onDisk).toEqual(json);
  });

  it('reports the newest recorded run when no run id is given', async () => {
    const cwd = await cwdOf();
    const older = recordAt({
      runId: 'run-20260924T000000Z-old000',
      createdAt: '2026-09-24T00:00:00.000Z',
    });
    const newer = await verifiedRecord(['node', '--test'], {
      runId: 'run-20260925T120000Z-new000',
    });
    const store = memoryRunStore();
    await store.save(older);
    await store.save(newer);
    const c = capture();

    await run(['node', 'mergesutra', 'report'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      report: { store, cwd },
    });

    expect(c.text()).toContain(newer.runId);
    expect(c.text()).not.toContain(older.runId);
  });

  it('fails when it is asked for a run nobody recorded', async () => {
    const cwd = await cwdOf();
    const store = memoryRunStore();
    const c = capture();

    const code = await run(['node', 'mergesutra', 'report', 'run-20260925T000000Z-ghost000'], {
      write: c.write,
      writeErr: c.writeErr,
      env: { NO_COLOR: '1' },
      report: { store, cwd },
    });

    expect(code).toBe(EXIT.ERROR);
    expect(c.errorText()).toMatch(/no run record/i);
    // A failed lookup must not leave an empty pack that looks like a report.
    const listed = await readdir(defaultRunStoreRoot(cwd)).catch(() => []);
    expect(listed.filter((name) => name.startsWith('run-20260925T000000Z-ghost'))).toEqual([]);
  });
});
