import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assembleInitialContext,
  MAX_CONTEXT_FILE_BYTES,
  readForModel,
} from '../../src/implement/context.js';
import { openConfinedReader } from '../../src/security/reader.js';
import { planTouching } from '../helpers/implement.js';

/**
 * What the model is shown before it asks for anything.
 *
 * The claim under test is that this stage never ships a repository: it ships the
 * files the plan means to change, through the same reader that refuses
 * credentials, `.git`, binaries and oversized reads — and when it withholds
 * something it says so, because a silently absent file is how an agent ends up
 * confidently describing code it was never shown.
 */

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function repo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-context-'));
  dirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, typeof contents === 'string' ? 'utf8' : undefined);
  }
  return root;
}

function readerFor(root: string) {
  return openConfinedReader(root);
}

const SMALL = {
  'src/parse.ts': 'export function parseDate(input: string) {\n  return new Date(input);\n}\n',
  'test/parse.test.ts': 'it("parses", () => {}\n',
  'README.md': '# datekit\n',
  'src/other.ts': 'export const other = 1;\n',
};

/** The real on-disk size of the fixture file the read tests keep opening. */
const PARSE_BYTES = Buffer.byteLength(SMALL['src/parse.ts'], 'utf8');

describe('assembleInitialContext', () => {
  it('sends the files the plan names and nothing else', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'test/parse.test.ts']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });

    expect(context.files.map((file) => file.relativePath)).toEqual([
      'src/parse.ts',
      'test/parse.test.ts',
    ]);
    expect(context.files[0]?.text).toContain('new Date(input)');
    // Not in the plan, so not in the request — even though it is in the tree.
    expect(JSON.stringify(context.files)).not.toContain('other');
    expect(context.skipped).toEqual([]);
    expect(context.notYetPresent).toEqual([]);
  });

  it('asks for each planned file once even when the plan repeats it', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'src/parse.ts', 'README.md']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    expect(context.files.map((file) => file.relativePath)).toEqual(['src/parse.ts', 'README.md']);
  });

  it('withholds a credential file and records why, without reading it', async () => {
    const reader = await readerFor(
      await repo({ ...SMALL, '.env': 'BHARATCODE_API_KEY=sk-cccccccccccccccc\n' }),
    );
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['.env', 'src/parse.ts']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });

    expect(JSON.stringify(context)).not.toContain('sk-cccccccccccccccc');
    expect(context.files.map((file) => file.relativePath)).toEqual(['src/parse.ts']);
    expect(context.skipped[0]?.relativePath).toBe('.env');
    expect(context.skipped[0]?.reason).toContain('credentials are not repository context');
  });

  it('withholds a path that crosses .git', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['.git/config']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    expect(context.files).toEqual([]);
    expect(context.skipped[0]?.reason).toContain('.git');
  });

  it('withholds a binary rather than pasting replacement characters to a model', async () => {
    const reader = await readerFor(
      await repo({
        ...SMALL,
        'assets/logo.png': Buffer.from([0x89, 0x50, 0x00, 0x01, 0x00, 0x02]),
      }),
    );
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['assets/logo.png']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    expect(context.files).toEqual([]);
    expect(context.skipped[0]?.reason).toContain('binary');
  });

  it('calls a planned path that does not exist yet what it is, not an error', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/guard.ts']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    // A plan is allowed to create a file; the prompt has to say it is absent so
    // the model does not describe a file that was never sent.
    expect(context.notYetPresent).toEqual(['src/guard.ts']);
    expect(context.skipped).toEqual([]);
  });

  it('truncates a file over the per-file cap and marks that it did', async () => {
    const big = 'x'.repeat(MAX_CONTEXT_FILE_BYTES + 4_096);
    const reader = await readerFor(await repo({ ...SMALL, 'src/big.ts': big }));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/big.ts']),
      limits: { maxContextFiles: 6, maxContextBytes: 512 * 1024 },
    });

    const file = context.files[0];
    expect(file?.truncated).toBe(true);
    expect(file?.text).toContain('(truncated:');
    expect(Buffer.byteLength(file?.text ?? '', 'utf8')).toBeLessThan(big.length);
  });

  it('stops at the file budget and says which files it refused to send', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'README.md', 'src/other.ts']),
      limits: { maxContextFiles: 2, maxContextBytes: 48 * 1024 },
    });
    expect(context.files).toHaveLength(2);
    expect(context.skipped).toEqual([
      { relativePath: 'src/other.ts', reason: 'context budget of 2 files is spent' },
    ]);
  });

  it('stops when the byte budget is gone instead of sending half a file silently', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'test/parse.test.ts', 'README.md']),
      limits: { maxContextFiles: 6, maxContextBytes: PARSE_BYTES },
    });

    // The first file fits exactly; everything after it has nothing to be paid from.
    expect(context.files.map((file) => file.relativePath)).toEqual(['src/parse.ts']);
    expect(context.skipped.map((entry) => entry.reason)).toEqual([
      'context byte budget is exhausted',
      'context byte budget is exhausted',
    ]);
    expect(context.bytes).toBe(PARSE_BYTES);
  });

  it('counts the bytes it actually handed over, not the bytes on disk', async () => {
    const reader = await readerFor(await repo(SMALL));
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'README.md']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    const total = context.files.reduce(
      (sum, file) => sum + Buffer.byteLength(file.text, 'utf8'),
      0,
    );
    expect(context.bytes).toBe(total);
  });

  it('lists names for the tree sample without walking into runtime or dependency directories', async () => {
    const reader = await readerFor(
      await repo({
        ...SMALL,
        'node_modules/vite/index.js': 'export default {};\n',
        '.mergesutra/runs/run-1.json': '{}\n',
        '.env': 'A=1\n',
      }),
    );
    const context = await assembleInitialContext({
      reader,
      plan: planTouching(['README.md']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });

    expect(context.treeSample).toContain('src/parse.ts');
    expect(context.treeSample.join(' ')).not.toContain('node_modules');
    expect(context.treeSample.join(' ')).not.toContain('.mergesutra');
    expect(context.treeSample).not.toContain('.env');
    // Names only: a tree sample is not a way to smuggle a credential.
    expect(JSON.stringify(context.treeSample)).not.toContain('A=1');
  });

  it('is read-only: assembling a context cannot change the repository', async () => {
    const root = await repo(SMALL);
    const reader = await readerFor(root);
    await assembleInitialContext({
      reader,
      plan: planTouching(['src/parse.ts', 'README.md']),
      limits: { maxContextFiles: 6, maxContextBytes: 48 * 1024 },
    });
    expect(await readFile(path.join(root, 'src/parse.ts'), 'utf8')).toBe(SMALL['src/parse.ts']);
  });
});

describe('readForModel', () => {
  it('returns a receipt instead of throwing when a model names a secret', async () => {
    const reader = await readerFor(await repo({ ...SMALL, '.netrc': 'machine x logname y\n' }));
    const outcome = await readForModel(reader, '.netrc', 4_096);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBeUndefined();
    expect(outcome.detail).toContain('credentials are not repository context');
    expect(outcome.detail).not.toContain('logname');
  });

  it('describes a good read as path, size and whether it was cut', async () => {
    const reader = await readerFor(await repo(SMALL));
    const outcome = await readForModel(reader, 'src/parse.ts', 4_096);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toBe(`src/parse.ts: ${PARSE_BYTES} bytes`);
    expect(outcome.detail).not.toContain('truncated');
    expect(outcome.text).toContain('parseDate');
  });

  it('labels a truncated read in the text the model sees, not only in the receipt', async () => {
    const reader = await readerFor(await repo(SMALL));
    const outcome = await readForModel(reader, 'src/parse.ts', 12);
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain(`(truncated: ${PARSE_BYTES} bytes on disk, 12 sent)`);
    expect(outcome.detail).toContain('(truncated)');
    // Only the first twelve bytes reach the model, so the rest cannot be quoted back.
    expect(outcome.text).toContain('export funct');
    expect(outcome.text).not.toContain('new Date(input)');
  });

  it('keeps a refusal to one line so it can go into an action log', async () => {
    const reader = await readerFor(await repo(SMALL));
    const outcome = await readForModel(reader, '../outside.md', 1_024);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).not.toContain('\n');
  });
});
