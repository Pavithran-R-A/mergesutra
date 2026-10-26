import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openConfinedWriter, type ConfinedWriter } from '../../src/security/writer.js';
import { makeFixtureTree } from '../helpers/fixture.js';

/**
 * The scratch file a write stages before its rename (audit finding F01).
 *
 * `writeText` builds its temp name from the process id and `Date.now()`, opens it
 * with `wx`, and on any failure removes that path unconditionally. Two writes in
 * the same directory and the same millisecond therefore compute one name: the
 * loser of the exclusive create runs cleanup against a file the winner still owns.
 * The counterexamples below hold the clock still so the collision is a fact of the
 * input, not a hope about scheduling.
 *
 * Production reaches `writeText` from one place (`src/implement/loop.ts`), one
 * action at a time, so the collision is not reachable through the CLI today. The
 * tests pin the module's own contract anyway: the writer promises an atomic replace
 * and that it removes only the scratch it opened, and that promise should not
 * depend on its caller never running two writes at once. A process that dies
 * between the create and the rename can still leave its scratch file behind; these
 * cases do not pretend otherwise.
 */

const SCRATCH = await makeFixtureTree({ placeholder: 'x\n' });
const WORKSPACE = path.join(SCRATCH, 'workspace');
let writer: ConfinedWriter;

const faults = vi.hoisted(() => new Map<string, NodeJS.ErrnoException>());
const opens = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const open = real.open as (...args: unknown[]) => Promise<unknown>;
  return {
    ...real,
    async open(...args: unknown[]) {
      const file = String(args[0]);
      opens.push(file);
      const fault = faults.get(file);
      if (fault !== undefined) throw fault;
      return open(...args);
    },
  };
});

beforeAll(async () => {
  await mkdir(WORKSPACE, { recursive: true });
  writer = await openConfinedWriter(WORKSPACE);
});

afterEach(() => {
  vi.useRealTimers();
  faults.clear();
});

afterAll(async () => {
  vi.useRealTimers();
  await rm(SCRATCH, { recursive: true, force: true }).catch(() => undefined);
});

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? String(result.reason) : 'fulfilled';
}

describe('the writer’s scratch file', () => {
  it('does not let two writes started in one millisecond destroy each other', async () => {
    const dir = path.join(WORKSPACE, 'same-ms');
    await mkdir(dir, { recursive: true });
    const aText = 'export const a = 1;\n';
    const bText = 'export const b = 1;\n';

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T12:00:00.000Z'));
    const [a, b] = await Promise.allSettled([
      writer.writeText('same-ms/a.ts', aText, { expectedAbsent: true }),
      writer.writeText('same-ms/b.ts', bText, { expectedAbsent: true }),
    ]);
    vi.useRealTimers();

    // Both writes were legal and independent. Neither may be refused because the
    // other was running, and neither may lose its bytes to the other's cleanup.
    expect(a.status, `first write: ${reasonOf(a)}`).toBe('fulfilled');
    expect(b.status, `second write: ${reasonOf(b)}`).toBe('fulfilled');
    expect(await readFile(path.join(dir, 'a.ts'), 'utf8')).toBe(aText);
    expect(await readFile(path.join(dir, 'b.ts'), 'utf8')).toBe(bText);
    expect((await readdir(dir)).filter((name) => name.includes('.mergesutra-tmp-'))).toEqual([]);
  });

  it('never removes a file at the scratch path that it did not create', async () => {
    const dir = path.join(WORKSPACE, 'foreign');
    await mkdir(dir, { recursive: true });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T13:00:00.000Z'));
    // The name the current implementation would choose for this process and this
    // millisecond. Whether it is the name used tomorrow does not matter: a file
    // the writer did not create at the path it is about to take is not its debris.
    const foreign = path.join(dir, `.mergesutra-tmp-${process.pid}-${Date.now()}`);
    const foreignText = 'somebody else’s scratch file\n';
    await writeFile(foreign, foreignText, 'utf8');

    const result = await writer.writeText('foreign/one.ts', 'one\n', { expectedAbsent: true }).then(
      () => null,
      (error: unknown) => error,
    );
    vi.useRealTimers();

    expect(result, 'the write itself should still be able to land').toBeNull();
    expect(await readFile(foreign, 'utf8'), 'a refused write deleted a foreign file').toBe(
      foreignText,
    );
    expect(await readFile(path.join(dir, 'one.ts'), 'utf8')).toBe('one\n');
  });

  it('refuses after sixteen taken names without touching any of them', async () => {
    const dir = path.join(WORKSPACE, 'exhausted');
    await mkdir(dir, { recursive: true });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T14:00:00.000Z'));
    const stem = `${process.pid}-${Date.now()}`;
    const taken = Array.from(
      { length: 16 },
      (_, attempt) => `.mergesutra-tmp-${stem}${attempt === 0 ? '' : `-${attempt}`}`,
    );
    for (const name of taken) await writeFile(path.join(dir, name), 'not ours\n', 'utf8');

    const result = await writer
      .writeText('exhausted/late.ts', 'late\n', { expectedAbsent: true })
      .then(
        () => null,
        (error: unknown) => error,
      );
    vi.useRealTimers();

    // The bound is a refusal, not a sixteenth-plus attempt under another name, and
    // not a cleanup of names this call never opened.
    expect(String(result), 'the write should be refused once every candidate is taken').toMatch(
      /16 scratch names/,
    );
    expect((await readdir(dir)).sort()).toEqual([...taken].sort());
    for (const name of taken) {
      expect(await readFile(path.join(dir, name), 'utf8'), name).toBe('not ours\n');
    }
  });

  it('propagates a permission failure instead of taking the next name', async () => {
    // The writer works from its realpath root, which can differ from the fixture
    // path on Windows (8.3 aliases); the fault key must name the path it uses.
    const dir = path.join(writer.root, 'denied');
    await mkdir(dir, { recursive: true });

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-26T15:00:00.000Z'));
    const first = path.join(dir, `.mergesutra-tmp-${process.pid}-${Date.now()}`);
    const denied = Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES' });
    faults.set(first, denied);
    const openedBefore = opens.length;

    const result = await writer
      .writeText('denied/late.ts', 'late\n', { expectedAbsent: true })
      .then(
        () => null,
        (error: unknown) => error,
      );
    vi.useRealTimers();

    // Only `EEXIST` proves a name taken. Any other open failure is the operating
    // system's own answer and must reach the caller, not become a retry under `-1`
    // that turns a fixable permission problem into a sixteenth-name collision.
    expect(result, 'a permission failure must not be retried under another name').toBe(denied);
    expect(opens.slice(openedBefore), 'the writer should stop after the refused name').toEqual([
      first,
    ]);
  });
});
