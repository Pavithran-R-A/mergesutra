import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_SEARCH_HITS,
  openConfinedReader,
} from '../../src/security/reader.js';
import { sha256Hex } from '../../src/security/digest.js';

/**
 * The bounds on what a workspace may hand to a model — S12-26 (brief §31).
 *
 * Confinement decides *where* a read may go. This file decides *how much* of it
 * a model gets, and the two properties are independent: a path can be perfectly
 * inside the workspace and still be a 40 MB binary, and the whole reason a run
 * has a read policy is that an agent which can look at the repository can also
 * fill its own prompt until the answer is worthless.
 *
 * Four bounds are measured here, each in both directions — the cap holds, and
 * the work under the cap still gets done:
 *
 * 1. a read stops at `MAX_READ_BYTES` and says it stopped, and a truncated read
 *    carries no content digest, because the writer's compare-before-write rule
 *    takes that digest as its precondition and a digest over a prefix would let
 *    a caller prove it had seen a file it had only seen the head of;
 * 2. bytes that are not text are refused rather than decoded into replacement
 *    characters and sent as if they were source;
 * 3. a listing reads at most `MAX_LIST_ENTRIES` names;
 * 4. a search is bounded in hits and marks itself truncated, and it only ever
 *    reads under the same per-file byte cap.
 *
 * Every fixture byte below is fake and every marker is distinctive, so a marker
 * appearing anywhere it should not — in a refusal, in a search hit, in a reason —
 * is a failure a reader can see rather than recognise.
 */

const BINARY_MARKER = 's1226-binary-payload-must-not-reach-a-prompt';
const NEEDLE = 's1226-needle';

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0, dirs.length)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function workspace(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mergesutra-reader-bounds-'));
  dirs.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

async function readerFor(files: Record<string, string | Buffer>) {
  return openConfinedReader(await workspace(files));
}

describe('a read that reaches the byte cap', () => {
  it('stops at the cap, flags itself truncated, and sends the cap worth of bytes', async () => {
    const reader = await readerFor({ 'src/big.ts': 'a'.repeat(MAX_READ_BYTES + 4096) });
    const receipt = await reader.readText('src/big.ts');
    expect(receipt.text.length).toBe(MAX_READ_BYTES);
    expect(receipt.truncated).toBe(true);
  });

  it('carries no content digest, so a prefix read cannot satisfy compare-before-write', async () => {
    const reader = await readerFor({ 'src/big.ts': 'a'.repeat(MAX_READ_BYTES + 1) });
    const receipt = await reader.readText('src/big.ts');
    expect(receipt.contentSha256).toBeNull();
    expect(receipt.bytes, 'the receipt still reports what is actually on disk').toBe(
      MAX_READ_BYTES + 1,
    );
  });

  it('digests the whole file when nothing was left behind', async () => {
    const bytes = Buffer.from('export const small = 1;\n', 'utf8');
    const reader = await readerFor({ 'src/small.ts': bytes });
    const receipt = await reader.readText('src/small.ts');
    expect(receipt.truncated).toBe(false);
    expect(receipt.contentSha256).toBe(sha256Hex(bytes));
  });

  it('leaves a file under the cap completely readable', async () => {
    const reader = await readerFor({ 'src/ok.ts': 'const x = 1;' });
    const receipt = await reader.readText('src/ok.ts');
    expect(receipt.text).toBe('const x = 1;');
    expect(receipt.truncated).toBe(false);
  });
});

describe('bytes that are not source text', () => {
  it('is refused because of a NUL in the head, and none of its bytes come back', async () => {
    const payload = Buffer.concat([
      Buffer.from(`head ${BINARY_MARKER}\n`, 'utf8'),
      Buffer.alloc(64, 0),
      Buffer.from(BINARY_MARKER, 'utf8'),
    ]);
    const reader = await readerFor({ 'assets/blob.bin': payload });
    const failure = await reader.readText('assets/blob.bin').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure, 'a binary file must not return a receipt').not.toBeNull();
    expect(failure?.message).toMatch(/binary/i);
    expect(failure?.message, 'a refusal is not a route for the payload to travel').not.toContain(
      BINARY_MARKER,
    );
  });

  it('is refused when the decode came back full of replacement characters', async () => {
    const reader = await readerFor({ 'vendor/mojibake.txt': '\uFFFD'.repeat(40) + NEEDLE });
    const failure = await reader.readText('vendor/mojibake.txt').then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure?.message).toMatch(/binary/i);
    expect(failure?.message).not.toContain(NEEDLE);
  });

  it('sends a text file that merely mentions a NUL-looking escape in its source', async () => {
    const reader = await readerFor({
      'src/escapes.ts': 'const nul = "\\u0000"; // the string, not a byte\n',
    });
    const receipt = await reader.readText('src/escapes.ts');
    expect(receipt.text).toContain('\\u0000');
  });
});

describe('a directory listing', () => {
  it('reads at most MAX_LIST_ENTRIES names, and more than none of them', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < MAX_LIST_ENTRIES + 60; index += 1) {
      files[`many/f-${String(index).padStart(4, '0')}.ts`] = 'export const x = 1;';
    }
    const reader = await readerFor(files);
    const entries = await reader.list('many');
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(MAX_LIST_ENTRIES);
  });

  it('lists a small directory completely', async () => {
    const reader = await readerFor({ 'few/a.ts': '1', 'few/b.ts': '2', 'few/c.ts': '3' });
    const entries = await reader.list('few');
    expect(entries.map((entry) => entry.name).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('the walk a search is built on', () => {
  it('does not descend past the depth it was given', async () => {
    const reader = await readerFor({ 'a/b/c/d/deep.ts': '1', 'a/shallow.ts': '2' });
    const withinDepth = await reader.walk('.', 3, 500);
    expect(withinDepth).toContain('a/shallow.ts');
    expect(withinDepth).not.toContain('a/b/c/d/deep.ts');
    const withRoom = await reader.walk('.', 5, 500);
    expect(withRoom).toContain('a/b/c/d/deep.ts');
  });

  it('stops at the file count it was given', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 30; index += 1) {
      files[`many/f-${String(index)}.ts`] = '1';
    }
    const reader = await readerFor(files);
    const walked = await reader.walk('.', 4, 10);
    expect(walked).toHaveLength(10);
  });
});

describe('a search over a workspace', () => {
  it('returns at most MAX_SEARCH_HITS and marks the result truncated', async () => {
    const lines = Array.from({ length: MAX_SEARCH_HITS + 20 }, (_, i) => `${NEEDLE} ${i}`).join(
      '\n',
    );
    const reader = await readerFor({ 'src/noisy.ts': lines });
    const result = await reader.search(NEEDLE);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(MAX_SEARCH_HITS);
    expect(result.truncated).toBe(true);
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  it('does not call a complete result truncated', async () => {
    const reader = await readerFor({ 'src/quiet.ts': `${NEEDLE} once\n` });
    const result = await reader.search(NEEDLE);
    expect(result.hits).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('reads each file under the same byte cap the direct read uses', async () => {
    const head = `${NEEDLE} at the top\n`;
    const reader = await readerFor({ 'src/huge.ts': head + 'x'.repeat(MAX_READ_BYTES * 2) });
    const result = await reader.search(NEEDLE);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.line).toBe(1);
  });
});
