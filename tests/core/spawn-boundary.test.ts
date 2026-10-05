import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isCredentialEnvName } from '../../src/core/runner.js';

/**
 * The two structural facts the credential rule depends on.
 *
 * `src/core/runner.ts` scrubs the model credential from every process it starts.
 * That is only a complete answer while two things stay true: nothing else in the
 * product starts a process, and the names on that list are the names the product
 * actually calls a credential. Both are one unannounced edit away from being
 * false, and neither is visible from the tests of the file that got the edit —
 * which is what a whole-tree guard is for.
 */

const SRC = path.join(process.cwd(), 'src');

async function everySourceFile(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await everySourceFile(full)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.sort();
}

/** Comments stripped: a doc comment that names `execFile` is not a call to it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('the boundary a process can be started from', () => {
  it('is exactly one module, so there is no second door to forget to scrub', async () => {
    const files = await everySourceFile(SRC);
    expect(files.length).toBeGreaterThan(20);

    const importers: string[] = [];
    for (const file of files) {
      const text = code(await readFile(file, 'utf8'));
      if (text.includes('node:child_process') || text.includes("'child_process'")) {
        importers.push(path.relative(SRC, file).replace(/\\/g, '/'));
      }
    }

    expect(importers).toEqual(['core/runner.ts']);
  });

  it('names the credential the configuration reads, and only credentials', () => {
    // The rule is a chosen list, not a prefix match: `BHARATCODE_MODEL` and
    // `BHARATCODE_API_BASE` are ordinary configuration that a repository's own
    // build may legitimately want, and scrubbing them would break something real
    // to protect nothing. If the key ever changes its name, this is the line that
    // has to change with it — and a rename that forgets it fails here first.
    expect(isCredentialEnvName('BHARATCODE_API_KEY')).toBe(true);
    expect(isCredentialEnvName('bharatcode_api_key')).toBe(true);
    expect(isCredentialEnvName('Bharatcode_Api_Key')).toBe(true);
    expect(isCredentialEnvName('BHARATCODE_KEY')).toBe(true);

    expect(isCredentialEnvName('BHARATCODE_MODEL')).toBe(false);
    expect(isCredentialEnvName('BHARATCODE_API_BASE')).toBe(false);
    expect(isCredentialEnvName('PATH')).toBe(false);
  });
});
