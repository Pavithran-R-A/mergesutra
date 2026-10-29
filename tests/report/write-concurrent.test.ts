import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeEvidencePack } from '../../src/report/write.js';

/**
 * Two pack writes for one run, in one process, at the same moment.
 *
 * `writeEvidencePack` stages each of the three files at a scratch name and renames it
 * into place. While that name carried only the pid, two writes in one process — a
 * `report` racing a `repair` in the same driver, a resumed run rendering its pack
 * twice — computed one scratch path per file: one rename took the file the other was
 * about to rename, and the loser failed with a raw `ENOENT` although its record was
 * written. The run lock orders *processes*; this file is about the writer ordering
 * itself, because the pack is the evidence a reviewer opens and no caller promise
 * should be what keeps its three files from being interleaved.
 *
 * The first write is held inside `writeFile` — after the scratch name is chosen,
 * before any byte is written — and the second is started while it is held. The mocked
 * `mkdir` records the call as it enters, so one event-loop turn is enough to tell
 * whether the second write began; no test here depends on two unpaused writers
 * happening to interleave on a busy machine.
 */

interface Gate {
  readonly hold: Promise<void>;
  readonly reached: Promise<void>;
  release(): void;
  markReached(): void;
}

const gates = vi.hoisted(() => new Map<string, Gate>());
const writes = vi.hoisted(() => [] as string[]);
const dirs = vi.hoisted(() => [] as string[]);

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof fsPromises>();
  const write = real.writeFile as (...args: unknown[]) => Promise<unknown>;
  const make = real.mkdir as (...args: unknown[]) => Promise<unknown>;
  return {
    ...real,
    async mkdir(...args: unknown[]) {
      dirs.push(String(args[0]));
      return make(...args);
    },
    async writeFile(...args: unknown[]) {
      const file = String(args[0]);
      writes.push(file);
      for (const [needle, gate] of gates) {
        if (file.includes(needle)) {
          // One-shot: only the write the test armed is held.
          gates.delete(needle);
          gate.markReached();
          await gate.hold;
          break;
        }
      }
      return write(...args);
    },
  };
});

const RUN = 'run-20260925T000000Z-pack001';

let root: string;

beforeEach(async () => {
  gates.clear();
  writes.length = 0;
  dirs.length = 0;
  root = await mkdtemp(path.join(tmpdir(), 'mergesutra-pack-concurrent-'));
});

afterEach(async () => {
  gates.clear();
  await rm(root, { recursive: true, force: true });
});

function pack(markdown: string) {
  return {
    runId: RUN,
    identity: '0'.repeat(64),
    files: {
      'report.md': markdown,
      'report.json': `${JSON.stringify({ markdown })}\n`,
      'commands.jsonl': `# ${markdown.replace(/\n/g, '')}\n`,
    },
  };
}

function blockFirstScratch(needle: string): { readonly reached: Promise<void>; release(): void } {
  let release!: () => void;
  let markReached!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  gates.set(needle, { hold, reached, release, markReached });
  return { reached, release };
}

/** Let microtasks and one macrotask turn run; an unqueued write issues its first call here. */
async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function reasonOf(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? String(result.reason) : 'fulfilled';
}

describe('two pack writes for one run', () => {
  it('holds the second behind the first instead of racing its scratch file', async () => {
    const gate = blockFirstScratch(path.join(RUN, 'report.md.'));

    const first = writeEvidencePack(root, pack('# first\n'));
    await gate.reached;
    // Observe only what the second write does from here on.
    writes.length = 0;
    const dirsBefore = dirs.length;

    const second = writeEvidencePack(root, pack('# second\n'));
    await turn();
    const started = dirs.length > dirsBefore;

    // Release before asserting so a failing run still settles both writes.
    gate.release();
    const [a, b] = await Promise.allSettled([first, second]);

    expect(started, 'the second write began while the first was still held').toBe(false);
    expect(a.status, `first write: ${reasonOf(a)}`).toBe('fulfilled');
    expect(b.status, `second write: ${reasonOf(b)}`).toBe('fulfilled');

    const dir = path.join(root, RUN);
    expect(await readFile(path.join(dir, 'report.md'), 'utf8')).toBe('# second\n');
    expect(await readFile(path.join(dir, 'report.json'), 'utf8')).toContain('# second');
    expect(await readFile(path.join(dir, 'commands.jsonl'), 'utf8')).toBe('# # second\n');
    expect((await readdir(dir)).sort()).toEqual(['commands.jsonl', 'report.json', 'report.md']);
  });

  it('gives every write its own scratch name, even when the pid is the same', async () => {
    await writeEvidencePack(root, pack('# first\n'));
    await writeEvidencePack(root, pack('# second\n'));

    const scratches = writes.filter((file) => file.endsWith('.tmp'));
    expect(scratches).toHaveLength(6);
    expect(new Set(scratches).size, 'a scratch name was reused by a second write').toBe(
      scratches.length,
    );
  });
});
